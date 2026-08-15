const express = require('express');
const router  = express.Router();
const { User, Listing, Conversation, Message, Order, ConversationReport, Broadcast } = require('../db/database');
const { adminMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');

// All admin routes require admin role
router.use(adminMiddleware);

// ── STATS ────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers, buyers, sellers,
      activeListings, totalListings,
      totalConversations, totalMessages,
      totalOrders, suspendedUsers, warnedUsers, pendingReports,
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'buyer' }),
      User.countDocuments({ role: 'seller' }),
      Listing.countDocuments({ status: 'active' }),
      Listing.countDocuments({ status: { $ne: 'deleted' } }),
      Conversation.countDocuments(),
      Message.countDocuments(),
      Order.countDocuments(),
      User.countDocuments({ account_status: 'suspended' }),
      User.countDocuments({ account_status: 'warned' }),
      ConversationReport.countDocuments({ status: 'pending' }),
    ]);
    res.json({
      totalUsers, buyers, sellers,
      activeListings, totalListings,
      totalConversations, totalMessages,
      totalOrders, suspendedUsers, warnedUsers, pendingReports,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
// GET /api/admin/users?q=&role=&status=&page=&limit=
router.get('/users', async (req, res) => {
  try {
    const { q, role, status, page = 1, limit = 20 } = req.query;
    const filter = { role: { $ne: 'admin' } };
    if (role && role !== 'all') filter.role = role;
    if (status && status !== 'all') filter.account_status = status;
    if (q) {
      const re = new RegExp(q, 'i');
      filter.$or = [{ full_name: re }, { email: re }];
    }
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('-password_hash -push_subscriptions -used_payment_refs')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    // Attach listing counts
    const ids = users.map(u => u._id);
    const counts = await Listing.aggregate([
      { $match: { seller_id: { $in: ids }, status: { $ne: 'deleted' } } },
      { $group: { _id: '$seller_id', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map(c => [String(c._id), c.count]));

    res.json({
      users: users.map(u => ({ ...u, id: u._id, listing_count: countMap[String(u._id)] || 0 })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users/:id — full user profile
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password_hash -push_subscriptions -used_payment_refs').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [listings, orders, convCount] = await Promise.all([
      Listing.find({ seller_id: user._id, status: { $ne: 'deleted' } })
        .sort({ created_at: -1 }).limit(10).lean(),
      Order.find({ $or: [{ buyer_id: user._id }, { seller_id: user._id }] })
        .sort({ created_at: -1 }).limit(10).lean(),
      Conversation.countDocuments({ $or: [{ buyer_id: user._id }, { seller_id: user._id }] }),
    ]);

    res.json({
      ...user, id: user._id,
      listings: listings.map(l => ({ ...l, id: l._id })),
      orders:   orders.map(o => ({ ...o, id: o._id })),
      conv_count: convCount,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/warn
router.post('/users/:id/warn', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'warned', warn_reason: reason.trim(), warned_at: new Date() } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/suspend
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'suspended', suspend_reason: reason.trim(), suspended_at: new Date() } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/unsuspend
router.post('/users/:id/unsuspend', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'active', suspend_reason: '', suspended_at: null, warn_reason: '', warned_at: null } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/message — send a system message/notification to a user
router.post('/users/:id/message', async (req, res) => {
  try {
    const { message, title } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    notifyUser(String(user._id), {
      title: '📣 Message from Bixcart Admin',
      body:  message.trim(),
      type:  'admin_message',
    }).catch(() => {});

    // Store message on user record for in-app inbox / popup modal
    await User.findByIdAndUpdate(req.params.id, {
      $push: {
        admin_messages: {
          title:   (title || '').trim(),
          content: message.trim(),
          sent_at: new Date(),
          read: false,
          acknowledged: false,
        },
      },
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin accounts' });

    // Soft-delete listings
    await Listing.updateMany({ seller_id: user._id }, { $set: { status: 'deleted' } });
    // Delete conversations + messages
    const convIds = (await Conversation.find({
      $or: [{ buyer_id: user._id }, { seller_id: user._id }]
    }).select('_id').lean()).map(c => c._id);
    await Message.deleteMany({ conversation_id: { $in: convIds } });
    await Conversation.deleteMany({ _id: { $in: convIds } });
    // Delete user
    await User.findByIdAndDelete(user._id);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BROADCAST MESSAGES ─────────────────────────────────────────────────────────
// Shared helper: build a Mongo filter for the recipient-selection filters
// used by both the recipient list and the "select all matching" send path.
function buildRecipientFilter(query) {
  const { q, role, status, verified, university } = query;
  const filter = { role: { $ne: 'admin' } };
  if (role && role !== 'all') filter.role = role;
  if (status && status !== 'all') filter.account_status = status;
  if (verified === 'yes') filter.is_verified = true;
  if (verified === 'no')  filter.is_verified = false;
  if (university && university !== 'all') filter.university = university;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ full_name: re }, { email: re }];
  }
  return filter;
}

// GET /api/admin/broadcast/universities — distinct universities, for the filter dropdown
router.get('/broadcast/universities', async (req, res) => {
  try {
    const list = await User.distinct('university', { role: { $ne: 'admin' } });
    res.json({ universities: list.filter(Boolean).sort() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcast/recipients?q=&role=&status=&verified=&university=&page=&limit=
// Paginated list of users matching the filters, for the checkbox picker.
router.get('/broadcast/recipients', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = buildRecipientFilter(req.query);
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('full_name email role account_status is_verified university avatar_url')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    res.json({
      users: users.map(u => ({ ...u, id: u._id })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcast/recipients/ids?...filters — all user ids matching the
// filters (no pagination). Used for "select all N users matching these filters".
router.get('/broadcast/recipients/ids', async (req, res) => {
  try {
    const filter = buildRecipientFilter(req.query);
    const ids = await User.find(filter).select('_id').lean();
    res.json({ ids: ids.map(u => String(u._id)), count: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/broadcast — send a message to a selected set of users.
// Body: { user_ids: [...], title, message, filters (optional, for audit history) }
router.post('/broadcast', async (req, res) => {
  try {
    const { user_ids, title, message, filters } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!Array.isArray(user_ids) || !user_ids.length) {
      return res.status(400).json({ error: 'At least one recipient is required' });
    }
    // Safety cap so a bad payload can't fan out unbounded writes/pushes
    if (user_ids.length > 20000) {
      return res.status(400).json({ error: 'Too many recipients in a single broadcast' });
    }

    // Only message real, existing, non-admin users
    const validUsers = await User.find({ _id: { $in: user_ids }, role: { $ne: 'admin' } }).select('_id').lean();
    const validIds = validUsers.map(u => u._id);
    if (!validIds.length) return res.status(400).json({ error: 'No valid recipients found' });

    const broadcast = await Broadcast.create({
      title:           (title || '').trim(),
      content:         message.trim(),
      filters:         filters || {},
      recipient_ids:   validIds,
      recipient_count: validIds.length,
      sent_by:         req.user.id,
    });

    await User.updateMany(
      { _id: { $in: validIds } },
      { $push: { admin_messages: {
          title:   (title || '').trim(),
          content: message.trim(),
          sent_at: new Date(),
          read: false,
          acknowledged: false,
          broadcast_id: broadcast._id,
        } } }
    );

    // Best-effort push notifications, fire-and-forget
    validIds.forEach(id => {
      notifyUser(String(id), {
        title: title?.trim() ? `📣 ${title.trim()}` : '📣 Message from Bixcart Admin',
        body:  message.trim(),
        type:  'admin_broadcast',
      }).catch(() => {});
    });

    res.json({ success: true, recipient_count: validIds.length, broadcast_id: broadcast._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcasts — history of past broadcasts with acknowledgment counts
router.get('/broadcasts', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Broadcast.countDocuments();
    const broadcasts = await Broadcast.find()
      .sort({ created_at: -1 }).skip(skip).limit(parseInt(limit))
      .populate('sent_by', 'full_name email')
      .lean();

    const ids = broadcasts.map(b => b._id);
    const ackCounts = await User.aggregate([
      { $match: { 'admin_messages.broadcast_id': { $in: ids } } },
      { $unwind: '$admin_messages' },
      { $match: { 'admin_messages.broadcast_id': { $in: ids }, 'admin_messages.acknowledged': true } },
      { $group: { _id: '$admin_messages.broadcast_id', count: { $sum: 1 } } },
    ]);
    const ackMap = Object.fromEntries(ackCounts.map(a => [String(a._id), a.count]));

    res.json({
      broadcasts: broadcasts.map(b => ({
        ...b, id: b._id,
        acknowledged_count: ackMap[String(b._id)] || 0,
      })),
      total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LISTINGS ──────────────────────────────────────────────────────────────────
// GET /api/admin/listings?q=&status=&page=&limit=
router.get('/listings', async (req, res) => {
  try {
    const { q, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    else filter.status = { $ne: 'deleted' };
    if (q) filter.$text = { $search: q };

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Listing.countDocuments(filter);
    const listings = await Listing.find(filter)
      .populate('seller_id', 'full_name email account_status')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    res.json({
      listings: listings.map(l => ({
        ...l, id: l._id,
        seller_name:   l.seller_id?.full_name,
        seller_email:  l.seller_id?.email,
        seller_status: l.seller_id?.account_status,
      })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/listings/:id/status
router.patch('/listings/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','pending','sold','deleted','flagged'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    const listing = await Listing.findByIdAndUpdate(
      req.params.id, { $set: { status } }, { new: true }
    ).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ ...listing, id: listing._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/listings/:id — hard delete
router.delete('/listings/:id', async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(
      req.params.id, { $set: { status: 'deleted' } }, { new: true }
    ).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTED CONVERSATIONS ────────────────────────────────────────────────────
// GET /api/admin/conversations?status=pending|resolved|all&page=&limit=
router.get('/conversations', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const reportFilter = {};
    if (status && status !== 'all') reportFilter.status = status;

    const total   = await ConversationReport.countDocuments(reportFilter);
    const reports = await ConversationReport.find(reportFilter)
      .populate('reporter_id', 'full_name email')
      .populate('fault_user_id', 'full_name')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    // Attach conversation details
    const convIds = reports.map(r => r.conversation_id);
    const convs = await Conversation.find({ _id: { $in: convIds } })
      .populate('buyer_id',   'full_name email account_status')
      .populate('seller_id',  'full_name email account_status')
      .populate('listing_id', 'title status')
      .lean();
    const convMap = Object.fromEntries(convs.map(c => [String(c._id), c]));

    res.json({
      conversations: reports.map(r => ({
        ...r,
        id: r._id,
        conversation: convMap[String(r.conversation_id)] || null,
      })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/conversations/:id — full thread (by report id OR conversation id)
router.get('/conversations/:id', async (req, res) => {
  try {
    // Try to find a report first; fall back to treating id as a conversation id
    let conv, report = null;
    report = await ConversationReport.findById(req.params.id)
      .populate('reporter_id', 'full_name email')
      .populate('fault_user_id', 'full_name email')
      .lean().catch(() => null);

    if (report) {
      conv = await Conversation.findById(report.conversation_id)
        .populate('buyer_id',   'full_name email')
        .populate('seller_id',  'full_name email')
        .populate('listing_id', 'title status price').lean();
    } else {
      conv = await Conversation.findById(req.params.id)
        .populate('buyer_id',   'full_name email')
        .populate('seller_id',  'full_name email')
        .populate('listing_id', 'title status price').lean();
    }
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await Message.find({ conversation_id: conv._id })
      .populate('sender_id', 'full_name role')
      .sort({ created_at: 1 }).lean();

    res.json({
      conversation: { ...conv, id: conv._id },
      report: report ? { ...report, id: report._id } : null,
      messages: messages.map(m => ({
        ...m, id: m._id,
        sender_name: m.sender_id?.full_name,
        sender_role: m.sender_id?.role,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/conversations/:reportId/resolve
router.post('/conversations/:reportId/resolve', async (req, res) => {
  try {
    const { fault_user_id, admin_note } = req.body;
    // fault_user_id can be null (no one at fault) or a valid user id
    const update = {
      status: 'resolved',
      fault_user_id: fault_user_id || null,
      admin_note: admin_note?.trim() || '',
      resolved_at: new Date(),
    };
    const report = await ConversationReport.findByIdAndUpdate(
      req.params.reportId, { $set: update }, { new: true }
    ).lean();
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ ...report, id: report._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/conversations/:reportId/notify — send notification message to one user
router.post('/conversations/:reportId/notify', async (req, res) => {
  try {
    const { user_id, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const report = await ConversationReport.findById(req.params.reportId).lean();
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const conv = await Conversation.findById(report.conversation_id).lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const validUserIds = [String(conv.buyer_id), String(conv.seller_id)];
    if (!validUserIds.includes(String(user_id))) {
      return res.status(400).json({ error: 'User is not part of this conversation' });
    }

    const msg = await Message.create({
      conversation_id:       conv._id,
      sender_id:             req.user.id,
      receiver_id:           user_id,
      content:               message.trim(),
      is_admin_notification: true,
      notification_to:       user_id,
    });

    await Conversation.findByIdAndUpdate(conv._id, {
      $set: { last_message: '📣 Admin notification', last_message_at: new Date() },
    });

    const { notifyUser } = require('../db/push');
    notifyUser(String(user_id), {
      title: '📣 Admin Notice',
      body: message.trim().slice(0, 100),
      type: 'admin_notification',
      url: `/pages/messages.html?conv=${conv._id}`,
    }).catch(() => {});

    res.json({ success: true, message_id: msg._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI FLAGGED CONTENT ────────────────────────────────────────────────────────
// GET /api/admin/flagged?type=all|conversations|listings
router.get('/flagged', async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    const results = {};

    if (type === 'all' || type === 'conversations') {
      const convs = await Conversation.find({ ai_flagged: true })
        .populate('buyer_id',  'full_name email')
        .populate('seller_id', 'full_name email')
        .populate('listing_id','title')
        .sort({ ai_flagged_at: -1 }).lean();
      results.conversations = convs.map(c => ({ ...c, id: c._id }));
    }

    if (type === 'all' || type === 'listings') {
      const listings = await Listing.find({ ai_flagged: true })
        .populate('seller_id', 'full_name email')
        .sort({ ai_flagged_at: -1 }).lean();
      results.listings = listings.map(l => ({ ...l, id: l._id }));
    }

    const pendingCount = await Promise.all([
      Conversation.countDocuments({ ai_flagged: true, ai_reviewed: false }),
      Listing.countDocuments({ ai_flagged: true, ai_reviewed: false }),
    ]);
    results.pending_count = pendingCount[0] + pendingCount[1];

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/flagged/conversations/:id/unflag
router.post('/flagged/conversations/:id/unflag', async (req, res) => {
  try {
    const { note } = req.body;
    const conv = await Conversation.findByIdAndUpdate(req.params.id, {
      $set: { ai_flagged: false, ai_reviewed: true, ai_flag_reason: note ? `[Cleared] ${note}` : '' },
    }, { new: true });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Notify both participants it's been cleared
    const notifyBoth = [String(conv.buyer_id), String(conv.seller_id)];
    notifyBoth.forEach(uid => notifyUser(uid, {
      title: '✅ Conversation Cleared',
      body:  'Your flagged conversation has been reviewed and cleared by an admin. You may continue.',
      type:  'ai_cleared',
      url:   `/pages/messages.html?conv=${conv._id}`,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/flagged/listings/:id/unflag
router.post('/flagged/listings/:id/unflag', async (req, res) => {
  try {
    const { action = 'restore' } = req.body; // 'restore' | 'remove'
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const newStatus = action === 'remove' ? 'deleted' : 'active';
    await Listing.findByIdAndUpdate(req.params.id, {
      $set: { ai_flagged: false, ai_reviewed: true, status: newStatus },
    });

    notifyUser(String(listing.seller_id), {
      title: action === 'remove' ? '❌ Listing Removed' : '✅ Listing Restored',
      body:  action === 'remove'
        ? `Your listing "${listing.title}" was removed after admin review.`
        : `Your listing "${listing.title}" has been reviewed and is now visible again.`,
      type: 'ai_cleared',
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
