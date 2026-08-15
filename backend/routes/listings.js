const express = require('express');
const router  = express.Router();
const { Listing, User, SavedListing, Order, CartItem } = require('../db/database');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { moderateListing } = require('../utils/aiModerator');

function lean(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  o.id = o._id; return o;
}

// Deterministic hash (FNV-1a) — same input always gives the same number, so
// "random" order stays put across requests instead of jumping on every reload.
// Needs real avalanche behavior: a naive polynomial hash barely moves when only
// the last few characters change, which is exactly what a week-number suffix is.
function stableHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967295; // normalize to 0–1
}

// Changes once a week — the shuffle order is stable all week, then reshuffles.
function currentWeekKey() {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// What categories has this buyer shown interest in? Purchases count more than
// cart adds, cart adds count more than saves — all three are optional signals.
async function getPreferredCategories(userId) {
  if (!userId) return [];
  const [saved, carted, bought] = await Promise.all([
    SavedListing.find({ user_id: userId }).populate('listing_id', 'category').lean(),
    CartItem.find({ user_id: userId }).populate('listing_id', 'category').lean(),
    Order.find({ buyer_id: userId }).populate('listing_id', 'category').lean(),
  ]);
  const weight = {};
  const bump = (cat, points) => { if (cat) weight[cat] = (weight[cat] || 0) + points; };
  saved.forEach(s  => bump(s.listing_id?.category, 1));
  carted.forEach(c => bump(c.listing_id?.category, 2));
  bought.forEach(o => bump(o.listing_id?.category, 3));
  return Object.entries(weight).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cat]) => cat);
}

// GET /api/listings/user/:userId  — before /:id
router.get('/user/:userId', async (req, res) => {
  try {
    const listings = await Listing
      .find({ seller_id: req.params.userId, status: { $ne: 'deleted' } })
      .sort({ created_at: -1 }).lean();
    res.json(listings.map(l => ({ ...l, id: l._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/listings
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { q, category, condition, min_price, max_price, sort = 'recommended', page = 1, limit = 12 } = req.query;

    const filter = { status: 'active' };
    if (category && category !== 'All') filter.category = category;
    if (condition) filter.condition = condition;
    if (min_price || max_price) {
      filter.price = {};
      if (min_price) filter.price.$gte = parseFloat(min_price);
      if (max_price) filter.price.$lte = parseFloat(max_price);
    }
    if (q) filter.$text = { $search: q };

    const sortMap = {
      oldest:     { created_at:  1 },
      price_asc:  { price:  1 },
      price_desc: { price: -1 },
      popular:    { views: -1 },
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    let listings, total;

    if (sortMap[sort]) {
      // A real, objective sort — price and view count mean what they say, no shuffling.
      total = await Listing.countDocuments(filter);
      listings = await Listing
        .find(filter)
        .populate('seller_id', 'full_name rating is_verified')
        .sort(sortMap[sort])
        .skip(skip).limit(parseInt(limit)).lean();
    } else {
      // 'recommended' (the default) — every listing gets a hash-based position that's
      // stable for the week, so browsing doesn't reshuffle on every reload, but the
      // catalog still rotates over time instead of the same items sitting on top
      // forever. Listings in the buyer's preferred categories get a soft boost —
      // more likely to surface earlier, not guaranteed to.
      const weekKey    = currentWeekKey();
      const preferred  = await getPreferredCategories(req.user?.id);
      const all = await Listing.find(filter).populate('seller_id', 'full_name rating is_verified').lean();

      const scored = all.map(l => {
        const base = stableHash(weekKey + l._id.toString());
        const score = preferred.includes(l.category) ? base * 0.5 : base;
        return { l, score };
      });
      scored.sort((a, b) => a.score - b.score);

      total = scored.length;
      listings = scored.slice(skip, skip + parseInt(limit)).map(x => x.l);
    }

    const enriched = listings.map(l => ({
      ...l, id: l._id,
      seller_id:       l.seller_id?._id || l.seller_id,
      seller_name:     l.seller_id?.full_name,
      seller_rating:   l.seller_id?.rating,
      seller_verified: l.seller_id?.is_verified,
    }));

    res.json({ listings: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/listings/saved — get current user's saved listings
router.get('/saved', authMiddleware, async (req, res) => {
  try {
    const saves = await SavedListing.find({ user_id: req.user.id })
      .populate({
        path: 'listing_id',
        populate: { path: 'seller_id', select: 'full_name rating rating_count is_verified' },
      })
      .sort({ created_at: -1 }).lean();

    const listings = saves
      .filter(s => s.listing_id && s.listing_id.status === 'active')
      .map(s => {
        const l = s.listing_id;
        return {
          ...l, id: l._id,
          saved_at:        s.created_at,
          seller_name:     l.seller_id?.full_name,
          seller_rating:   l.seller_id?.rating,
          seller_verified: l.seller_id?.is_verified,
          seller_id:       l.seller_id?._id || l.seller_id,
          is_saved:        true,
        };
      });
    res.json({ listings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const listing = await Listing
      .findById(req.params.id)
      .populate('seller_id', 'full_name rating rating_count bio is_verified created_at university')
      .lean();

    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    Listing.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

    let is_saved = false;
    if (req.user) {
      const sv = await SavedListing.findOne({ user_id: req.user.id, listing_id: req.params.id });
      is_saved = !!sv;
    }

    const related = await Listing
      .find({ category: listing.category, _id: { $ne: req.params.id }, status: 'active' })
      .populate('seller_id', 'full_name')
      .limit(4).lean();

    const s = listing.seller_id || {};
    const seller_reviews = await Order.find({ seller_id: s._id, buyer_rating: { $ne: null } })
      .populate('buyer_id', 'full_name avatar_url')
      .select('buyer_rating buyer_review buyer_rated_at buyer_id')
      .sort({ buyer_rated_at: -1 }).limit(6).lean();

    res.json({
      ...listing, id: listing._id,
      seller_name:         s.full_name,
      seller_rating:       s.rating,
      seller_rating_count: s.rating_count,
      seller_bio:          s.bio,
      seller_verified:     s.is_verified,
      seller_joined:       s.created_at,
      seller_university:  s.university,
      seller_hostel:       s.hostel_name,
      seller_room:         s.room_number,
      seller_shop:         s.shop_name,
      seller_shop_number:  s.shop_number,
      seller_delivery_info: s.delivery_info,
      campus:              s.university,
      is_saved,
      seller_reviews:      seller_reviews.map(r => ({
        rating:      r.buyer_rating,
        review:      r.buyer_review,
        rated_at:    r.buyer_rated_at,
        buyer_name:  r.buyer_id?.full_name || 'ACU Student',
      })),
      related: related.map(r => ({ ...r, id: r._id, seller_name: r.seller_id?.full_name })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/listings — seller only, must have credits
router.post('/', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'seller') return res.status(403).json({ error: 'Only sellers can create listings' });

    const { title, description, price, original_price, category, condition, images } = req.body;
    if (!title || !description || !price || !category || !condition)
      return res.status(400).json({ error: 'Missing required fields' });

    if (Array.isArray(images) && images.length > 5)
      return res.status(400).json({ error: 'Maximum 5 photos allowed per listing' });

    const listing = await Listing.create({
      seller_id: req.user.id, title, description,
      price: parseFloat(price),
      original_price: original_price ? parseFloat(original_price) : null,
      category, condition,
      images: Array.isArray(images) ? images.slice(0, 5) : [],
    });

    // Listings are free; no listing credit deduction.

    // ── AI moderation (non-blocking) ─────────────────────────────────────────
    setImmediate(async () => {
      try {
        const result = await moderateListing({ title, description, category });
        if (result.flagged) {
          await Listing.findByIdAndUpdate(listing._id, {
            $set: {
              status:           'flagged',
              ai_flagged:       true,
              ai_flag_reason:   result.reason,
              ai_flag_category: result.category,
              ai_flagged_at:    new Date(),
            },
          });
          notifyUser(String(req.user.id), {
            title: '⚠️ Listing Hidden by AI',
            body:  `Your listing "${title}" was flagged: ${result.reason}. It has been hidden pending admin review.`,
            type:  'ai_flag',
          }).catch(() => {});
        }
      } catch(e) { console.warn('[AI mod] listing check failed:', e.message); }
    });

    res.json({ ...listing.toObject(), id: listing._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const EDIT_LOCK_MS = 90 * 60 * 1000; // 90 minutes

// PUT /api/listings/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (String(listing.seller_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (listing.ai_flagged) return res.status(403).json({ error: 'This listing has been flagged by our AI and cannot be edited until an admin reviews it.' });

    const ageMs = Date.now() - new Date(listing.created_at).getTime();
    if (ageMs > EDIT_LOCK_MS)
      return res.status(403).json({ error: 'Listings can only be edited within 90 minutes of being created.' });

    const { title, description, price, original_price, category, condition, status, images } = req.body;
    if (Array.isArray(images) && images.length > 5)
      return res.status(400).json({ error: 'Maximum 5 photos allowed per listing' });

    const updated = await Listing.findByIdAndUpdate(
      req.params.id,
      { $set: { title, description, price: parseFloat(price), original_price: original_price ? parseFloat(original_price) : null, category, condition, ...(status ? { status } : {}), ...(Array.isArray(images) ? { images: images.slice(0, 5) } : {}) } },
      { new: true }
    ).lean();
    res.json({ ...updated, id: updated._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/listings/:id/mark-sold — seller marks their listing as sold.
// This is a lifecycle action, not a content edit, so it's not subject to the
// 90-minute edit lock. A sold listing immediately leaves the active
// marketplace (GET / only returns status:'active' listings).
router.post('/:id/mark-sold', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (String(listing.seller_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (listing.ai_flagged) return res.status(403).json({ error: 'This listing has been flagged by our AI and cannot be changed until an admin reviews it.' });
    if (listing.status === 'deleted') return res.status(400).json({ error: 'This listing has been deleted' });

    const updated = await Listing.findByIdAndUpdate(req.params.id, { $set: { status: 'sold' } }, { new: true }).lean();
    res.json({ ...updated, id: updated._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/listings/:id/relist — seller undoes a "mark as sold", putting the
// listing back on the active marketplace.
router.post('/:id/relist', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (String(listing.seller_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (listing.status !== 'sold') return res.status(400).json({ error: 'Only sold listings can be relisted' });

    const updated = await Listing.findByIdAndUpdate(req.params.id, { $set: { status: 'active' } }, { new: true }).lean();
    res.json({ ...updated, id: updated._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/listings/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (String(listing.seller_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (listing.ai_flagged) return res.status(403).json({ error: 'This listing has been flagged by our AI and cannot be deleted until an admin reviews it.' });
    await Listing.findByIdAndUpdate(req.params.id, { $set: { status: 'deleted' } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/listings/:id/save — buyers only
router.post('/:id/save', authMiddleware, async (req, res) => {
  try {
    const existing = await SavedListing.findOne({ user_id: req.user.id, listing_id: req.params.id });
    if (existing) {
      await SavedListing.deleteOne({ _id: existing._id });
      await Listing.findByIdAndUpdate(req.params.id, { $inc: { saves: -1 } });
      res.json({ saved: false });
    } else {
      await SavedListing.create({ user_id: req.user.id, listing_id: req.params.id });
      await Listing.findByIdAndUpdate(req.params.id, { $inc: { saves: 1 } });

      // Notify seller
      const listing = await Listing.findById(req.params.id).lean();
      const liker   = await User.findById(req.user.id).lean();
      if (listing?.seller_id && String(listing.seller_id) !== String(req.user.id)) {
        notifyUser(String(listing.seller_id), {
          title: 'Someone liked your listing',
          body: `${liker?.full_name || 'A buyer'} saved "${listing.title}"`,
          type: 'like',
          tag: `like-${listing._id}`,
          url: `/pages/listing.html?id=${listing._id}`,
        }).catch(() => {});
      }

      res.json({ saved: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
