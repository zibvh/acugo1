const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Order, Listing, User, SavedListing, CartItem } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// GET /api/orders/stats  — before /:id
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const [listings, orders] = await Promise.all([
      Listing.find({ seller_id: uid, status: { $ne: 'deleted' } }).lean(),
      Order.find({ seller_id: uid }).lean(),
    ]);
    res.json({
      total_listings:  listings.length,
      active_listings: listings.filter(l => l.status === 'active').length,
      sold_listings:   listings.filter(l => l.status === 'sold').length,
      total_revenue:   orders.filter(o => o.status === 'completed').reduce((s, o) => s + (o.amount || 0), 0),
      total_views:     listings.reduce((s, l) => s + (l.views || 0), 0),
      total_saved:     listings.reduce((s, l) => s + (l.saves || 0), 0),
      pending_orders:  orders.filter(o => o.status === 'pending').length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/saved
router.get('/saved', authMiddleware, async (req, res) => {
  try {
    const saved = await SavedListing
      .find({ user_id: req.user.id })
      .populate({ path: 'listing_id', populate: { path: 'seller_id', select: 'full_name university rating' } })
      .sort({ created_at: -1 }).lean();

    const results = saved
      .filter(s => s.listing_id && s.listing_id.status !== 'deleted')
      .map(s => {
        const l = s.listing_id;
        return {
          ...l, id: l._id,
          seller_name:       l.seller_id?.full_name,
          seller_university: l.seller_id?.university,
          seller_rating:     l.seller_id?.rating,
        };
      });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/buying
router.get('/buying', authMiddleware, async (req, res) => {
  try {
    const orders = await Order
      .find({ buyer_id: req.user.id })
      .populate('listing_id', 'title images category')
      .populate('seller_id',  'full_name university')
      .sort({ created_at: -1 }).lean();

    res.json(orders.map(o => ({
      ...o, id: o._id,
      listing_title:    o.listing_id?.title,
      listing_images:   o.listing_id?.images || [],
      category:         o.listing_id?.category,
      seller_id:        o.seller_id?._id || o.seller_id,
      seller_name:      o.seller_id?.full_name,
      seller_university:o.seller_id?.university,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/selling
router.get('/selling', authMiddleware, async (req, res) => {
  try {
    const orders = await Order
      .find({ seller_id: req.user.id })
      .populate('listing_id', 'title images category')
      .populate('buyer_id',   'full_name university')
      .sort({ created_at: -1 }).lean();

    res.json(orders.map(o => ({
      ...o, id: o._id,
      listing_title:   o.listing_id?.title,
      listing_images:  o.listing_id?.images || [],
      category:        o.listing_id?.category,
      buyer_id:        o.buyer_id?._id || o.buyer_id,
      buyer_name:      o.buyer_id?.full_name,
      buyer_university:o.buyer_id?.university,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { listing_id, meetup_location, meetup_time } = req.body;
    const listing = await Listing.findOne({ _id: listing_id, status: 'active' });
    if (!listing) return res.status(404).json({ error: 'Listing not found or no longer available' });
    if (String(listing.seller_id) === String(req.user.id))
      return res.status(400).json({ error: 'Cannot buy your own listing' });

    const order = await Order.create({
      listing_id, buyer_id: req.user.id, seller_id: listing.seller_id,
      amount: listing.price,
      meetup_location: meetup_location || null,
      meetup_time:     meetup_time     || null,
    });
    await Listing.findByIdAndUpdate(listing_id, { $set: { status: 'pending' } });
    res.json({ ...order.toObject(), id: order._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/checkout — turns the buyer's cart into orders, AFTER verifying
// a completed Paystack payment for the full cart total. A cart can hold items
// from several sellers, so it splits into one Order per seller; every resulting
// order shares a checkout_group (one purchase) and the same payment_reference.
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { delivery_address, payment_reference } = req.body;

    if (!delivery_address?.full_name || !delivery_address?.phone || !delivery_address?.address)
      return res.status(400).json({ error: 'Full name, phone, and address are required' });
    if (!payment_reference)
      return res.status(400).json({ error: 'payment_reference is required' });

    const cartItems = await CartItem.find({ user_id: req.user.id }).populate('listing_id');
    if (!cartItems.length) return res.status(400).json({ error: 'Your cart is empty' });

    // Re-check every item is still buyable — cart may be stale (item sold/removed since adding)
    const unavailable = cartItems.filter(c => !c.listing_id || c.listing_id.status !== 'active');
    if (unavailable.length) {
      return res.status(409).json({
        error: 'Some items in your cart are no longer available',
        unavailable_ids: unavailable.map(c => c.listing_id?._id).filter(Boolean),
      });
    }

    // A reference can only ever pay for one checkout — blocks replaying the same payment
    const alreadyUsed = await User.findOne({ used_payment_refs: payment_reference });
    if (alreadyUsed) return res.status(409).json({ error: 'Payment reference already used' });

    const expectedTotalKobo = cartItems.reduce((sum, c) => sum + c.listing_id.price, 0) * 100;

    const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
    const paystackRes  = await _fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(payment_reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const paystackData = await paystackRes.json();

    console.log('[checkout] Paystack response:', JSON.stringify(paystackData));

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      console.error('[checkout] Not verified. status:', paystackData.data?.status, 'msg:', paystackData.message);
      return res.status(400).json({ error: 'Payment not verified: ' + (paystackData.message || paystackData.data?.gateway_response || 'unknown') });
    }
    if (paystackData.data.amount !== expectedTotalKobo) {
      console.error('[checkout] Amount mismatch. paid:', paystackData.data.amount, 'expected:', expectedTotalKobo);
      return res.status(400).json({ error: 'Paid amount does not match cart total — contact support' });
    }

    const checkout_group = uuidv4();
    const orders = await Order.insertMany(cartItems.map(c => ({
      listing_id:        c.listing_id._id,
      buyer_id:          req.user.id,
      seller_id:         c.listing_id.seller_id,
      amount:            c.listing_id.price,
      checkout_group,
      fulfillment:       'delivery',
      delivery_address,
      payment_method:    'card',
      payment_status:    'paid',
      payment_reference,
    })));

    await Listing.updateMany(
      { _id: { $in: cartItems.map(c => c.listing_id._id) } },
      { $set: { status: 'pending' } }
    );
    await CartItem.deleteMany({ user_id: req.user.id });
    await User.findByIdAndUpdate(req.user.id, { $addToSet: { used_payment_refs: payment_reference } });

    console.log('[checkout] Success. orders:', orders.length, 'group:', checkout_group);
    res.json({
      checkout_group,
      order_count: orders.length,
      total: orders.reduce((sum, o) => sum + o.amount, 0),
      orders: orders.map(o => ({ ...o.toObject(), id: o._id })),
    });
  } catch (e) {
    console.error('[checkout] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/orders/:id/status
router.put('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const role = String(order.seller_id) === String(req.user.id) ? 'seller'
               : String(order.buyer_id)  === String(req.user.id) ? 'buyer' : null;
    if (!role) return res.status(403).json({ error: 'Forbidden' });

    const valid = {
      seller: { pending: ['confirmed','cancelled'], confirmed: ['completed','cancelled'] },
      buyer:  { pending: ['cancelled'] },
    };
    if (!valid[role]?.[order.status]?.includes(status))
      return res.status(400).json({ error: 'Invalid status transition' });

    await Order.findByIdAndUpdate(req.params.id, { $set: { status } });

    if (status === 'completed') await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' }   });
    if (status === 'cancelled') await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'active' } });

    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/mark-complete — buyer or seller marks their side done
router.post('/:id/mark-complete', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isBuyer  = String(order.buyer_id)  === String(uid);
    const isSeller = String(order.seller_id) === String(uid);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });

    // Only allow for confirmed orders
    if (!['confirmed', 'completing'].includes(order.status))
      return res.status(400).json({ error: 'Order must be confirmed before marking complete' });

    const update = {};
    if (isBuyer)  update.buyer_marked_complete  = true;
    if (isSeller) update.seller_marked_complete = true;

    // If both sides have now marked complete → finalize
    const buyerDone  = isBuyer  ? true : order.buyer_marked_complete;
    const sellerDone = isSeller ? true : order.seller_marked_complete;

    if (buyerDone && sellerDone) {
      update.status = 'completed';
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' } });
    } else {
      update.status = 'completing'; // waiting for the other side
    }

    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    res.json({ ...updated.toObject(), id: updated._id, needs_rating: isBuyer && buyerDone && sellerDone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/resolve — buyer or seller marks deal as completed or cancelled from chat bubble
router.post('/:id/resolve', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const { outcome } = req.body; // 'completed' or 'cancelled'
    if (!['completed','cancelled'].includes(outcome))
      return res.status(400).json({ error: 'outcome must be completed or cancelled' });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isBuyer  = String(order.buyer_id)  === String(uid);
    const isSeller = String(order.seller_id) === String(uid);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });

    if (order.status === 'completed' || order.status === 'cancelled')
      return res.status(400).json({ error: `Order already ${order.status}` });

    const update = { status: outcome };
    if (outcome === 'completed') {
      update.buyer_marked_complete  = true;
      update.seller_marked_complete = true;
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' } });
    } else {
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'active' } });
    }

    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    res.json({ ...updated.toObject(), id: updated._id, needs_rating: isBuyer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/rate — buyer rates seller after order completes
router.post('/:id/rate', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.buyer_id) !== String(uid))
      return res.status(403).json({ error: 'Only the buyer can rate this order' });
    if (order.status !== 'completed' && order.status !== 'cancelled')
      return res.status(400).json({ error: 'Order must be completed or cancelled first' });
    if (order.buyer_rating)
      return res.status(409).json({ error: 'You have already rated this order' });

    await Order.findByIdAndUpdate(req.params.id, {
      $set: { buyer_rating: rating, buyer_review: (review || '').trim(), buyer_rated_at: new Date() },
    });

    // Recalculate seller's rating
    const seller = await User.findById(order.seller_id);
    const newCount = (seller.rating_count || 0) + 1;
    const newRating = (((seller.rating || 0) * (seller.rating_count || 0)) + rating) / newCount;
    await User.findByIdAndUpdate(order.seller_id, {
      $set: { rating: Math.round(newRating * 10) / 10, rating_count: newCount },
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
