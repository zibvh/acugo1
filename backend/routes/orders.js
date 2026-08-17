const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Order, Listing, User, SavedListing, CartItem, getSellerCommissionInfo } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { generateVerificationCode, verifyEscrowCode, calculatePayout } = require('../utils/escrow');
const { createTransferRecipient, initiateTransfer } = require('../utils/paystack');
const { sendOrderSellerAlertEmail, sendOrderRefundEmail } = require('../utils/email');

// GET /api/orders/stats  — before /:id
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const [listings, orders, seller] = await Promise.all([
      Listing.find({ seller_id: uid, status: { $ne: 'deleted' } }).lean(),
      Order.find({ seller_id: uid }).lean(),
      User.findById(uid).select('successful_sales_count commission_tier commission_percent').lean(),
    ]);
    const commission = getSellerCommissionInfo(Number(seller?.successful_sales_count || 0));
    res.json({
      total_listings:  listings.length,
      active_listings: listings.filter(l => l.status === 'active').length,
      sold_listings:   listings.filter(l => l.status === 'sold').length,
      total_revenue:   orders.filter(o => o.status === 'completed').reduce((s, o) => s + (o.amount || 0), 0),
      total_views:     listings.reduce((s, l) => s + (l.views || 0), 0),
      total_saved:     listings.reduce((s, l) => s + (l.saves || 0), 0),
      pending_orders:  orders.filter(o => o.status === 'pending').length,
      commission_tier: commission.level,
      commission_percent: commission.commission_percent,
      successful_sales_count: commission.sales_count,
      progress_to_next: commission.progress_to_next,
      remaining_sales_to_next: commission.remaining_sales_to_next,
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

    res.json(orders.map(o => {
      // escrow_code is deliberately left out — it's for the seller to hand over
      // in person, not something the buyer should be able to read from the app
      const { escrow_code, ...safe } = o;
      return {
        ...safe, id: o._id,
        listing_title:    o.listing_id?.title,
        listing_images:   o.listing_id?.images || [],
        category:         o.listing_id?.category,
        seller_id:        o.seller_id?._id || o.seller_id,
        seller_name:      o.seller_id?.full_name,
        seller_university:o.seller_id?.university,
      };
    }));
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

    const expectedTotalKobo = cartItems.reduce((sum, c) => sum + Number(c.listing_id.price || 0), 0) * 100;

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

    const actualPaidKobo = Number(paystackData.data?.amount || 0);
    if (actualPaidKobo < expectedTotalKobo) {
      console.error('[checkout] Amount mismatch. paid:', actualPaidKobo, 'expected:', expectedTotalKobo);
      return res.status(400).json({ error: 'Paid amount is less than the cart total — contact support' });
    }
    const gatewayFeeKobo = actualPaidKobo - expectedTotalKobo;
    if (gatewayFeeKobo > 0) {
      console.log('[checkout] Paystack gateway fee detected:', gatewayFeeKobo, 'kobo');
    }

    const checkout_group = uuidv4();
    const escrowCode = generateVerificationCode();
    const checkoutOrders = cartItems.map(c => {
      const amount = Number(c.listing_id.price || 0);
      const platformFee = Number((amount * 0.03 + 300).toFixed(2));
      const sellerPayout = Number(Math.max(0, amount - platformFee).toFixed(2));
      const listingWindow = c.listing_id.delivery_window || '1d';
      const deliveryMinutes = { '6h': 6 * 60, '12h': 12 * 60, '1d': 24 * 60, '3d': 72 * 60, '7d': 7 * 24 * 60 }[listingWindow] || 24 * 60;
      return {
        listing_id:           c.listing_id._id,
        buyer_id:             req.user.id,
        seller_id:            c.listing_id.seller_id,
        amount,
        status:               'paid',
        escrow_status:        'held',
        escrow_code:          escrowCode,
        escrow_code_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        response_deadline_at: new Date(Date.now() + 1000 * 60 * 60 * 6),
        delivery_deadline_at: new Date(Date.now() + 1000 * 60 * deliveryMinutes),
        platform_fee_percent: 3,
        platform_fee_amount:  platformFee,
        seller_payout_amount: sellerPayout,
        checkout_group,
        fulfillment:          'delivery',
        delivery_address,
        payment_method:       'card',
        payment_status:       'paid',
        payment_reference,
      };
    });
    const orders = await Order.insertMany(checkoutOrders);

    await Listing.updateMany(
      { _id: { $in: cartItems.map(c => c.listing_id._id) } },
      { $set: { status: 'pending' } }
    );
    await CartItem.deleteMany({ user_id: req.user.id });
    await User.findByIdAndUpdate(req.user.id, { $addToSet: { used_payment_refs: payment_reference } });

    for (const order of orders) {
      const sellerId = String(order.seller_id);
      const seller = await User.findById(sellerId).select('email full_name').lean();
      const listing = await Listing.findById(order.listing_id).select('title delivery_window').lean();
      await notifyUser(sellerId, {
        title: 'Payment held in escrow',
        body: 'A buyer has paid for your item. Please fulfil the order and share the delivery details.',
        type: 'escrow',
        url: `/pages/messages.html?conv=${order._id}`,
      }).catch(() => {});
      if (seller?.email) {
        await sendOrderSellerAlertEmail(seller.email, {
          buyerName: req.user.full_name || 'A buyer',
          listingTitle: listing?.title || 'your item',
          orderId: String(order._id),
          deliveryWindow: listing?.delivery_window || '1d',
        }).catch(() => {});
      }
    }

    console.log('[checkout] Success. orders:', orders.length, 'group:', checkout_group, 'escrow_code:', escrowCode);
    res.json({
      checkout_group,
      order_count: orders.length,
      total: orders.reduce((sum, o) => sum + o.amount, 0),
      // NOTE: verification_code intentionally NOT included here. The code is
      // for the seller to hand to the buyer at pickup/delivery, proving the
      // item actually changed hands — sending it to the buyer up front would
      // let them "confirm delivery" without ever receiving anything.
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

// GET /api/orders/:id/escrow
router.get('/:id/escrow', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const isBuyer = String(order.buyer_id) === String(req.user.id);
    const isSeller = String(order.seller_id) === String(req.user.id);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });

    res.json({
      id: order._id,
      status: order.status,
      escrow_status: order.escrow_status,
      verification_code: order.escrow_code,
      platform_fee_amount: order.platform_fee_amount,
      seller_payout_amount: order.seller_payout_amount,
      released_at: order.released_at,
      delivered_at: order.delivered_at,
      expires_at: order.escrow_code_expires_at,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/accept
router.post('/:id/accept', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can accept this order' });
    if (order.status === 'cancelled' || order.escrow_status === 'released')
      return res.status(400).json({ error: 'This order can no longer be accepted' });
    if (new Date(order.response_deadline_at || Date.now()) < new Date())
      return res.status(400).json({ error: 'This order expired because the seller did not respond in time' });

    const listing = await Listing.findById(order.listing_id).select('delivery_window').lean();
    const deliveryMinutes = { '6h': 6 * 60, '12h': 12 * 60, '1d': 24 * 60, '3d': 72 * 60, '7d': 7 * 24 * 60 }[listing?.delivery_window || '1d'] || 24 * 60;
    order.status = 'confirmed';
    order.seller_accepted_at = new Date();
    order.delivery_deadline_at = new Date(Date.now() + 1000 * 60 * deliveryMinutes);
    await order.save();

    await notifyUser(String(order.buyer_id), {
      title: 'Seller accepted your order',
      body: 'The seller accepted your item request. Delivery or pickup must happen within the listed timeframe.',
      type: 'escrow',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({ success: true, order: { ...order.toObject(), id: order._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/mark-shipped
router.post('/:id/mark-shipped', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can mark this order as shipped' });
    if (order.escrow_status === 'released' || order.status === 'cancelled')
      return res.status(400).json({ error: 'This order can no longer be updated' });
    if (order.delivery_deadline_at && new Date(order.delivery_deadline_at) < new Date()) {
      return res.status(400).json({ error: 'This order missed the delivery deadline and will be refunded automatically' });
    }

    order.status = 'fulfilled';
    order.delivered_at = new Date();
    await order.save();

    await notifyUser(String(order.buyer_id), {
      title: 'Seller has fulfilled your order',
      body: 'The seller has marked the order as fulfilled. Confirm the verification code to release the escrow.',
      type: 'escrow',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({ success: true, order: { ...order.toObject(), id: order._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/confirm-delivery
router.post('/:id/confirm-delivery', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.buyer_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
    if (order.status !== 'fulfilled')
      return res.status(400).json({ error: 'The seller has not marked this order as shipped yet' });
    if (!order.escrow_code) return res.status(400).json({ error: 'No escrow verification code is attached to this order' });
    if (order.escrow_status === 'released')
      return res.status(409).json({ error: 'Escrow has already been released for this order' });
    if (order.escrow_status === 'cancelled')
      return res.status(409).json({ error: 'Escrow was cancelled for this order' });
    if (order.delivery_deadline_at && new Date(order.delivery_deadline_at) < new Date()) {
      return res.status(400).json({ error: 'This order missed its delivery deadline and must be refunded automatically' });
    }
    if (!verifyEscrowCode(code, order.escrow_code))
      return res.status(400).json({ error: 'Verification code is incorrect' });

    const payoutAmount = Number(order.seller_payout_amount || calculatePayout(order.amount, order.platform_fee_percent || 3, 300));
    const platformFee = Number(order.platform_fee_amount || (order.amount - payoutAmount));

    order.status = 'completed';
    order.escrow_status = 'released';
    order.released_at = new Date();
    order.buyer_marked_complete = true;
    order.seller_marked_complete = true;
    order.platform_fee_amount = platformFee;
    order.seller_payout_amount = payoutAmount;
    order.payout_status = 'pending';
    await order.save();

    await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' } });

    const sellerUser = await User.findById(order.seller_id);
    if (sellerUser && order.status === 'completed') {
      const completedSales = Number(sellerUser.successful_sales_count || 0) + 1;
      const commissionInfo = getSellerCommissionInfo(completedSales);
      sellerUser.successful_sales_count = completedSales;
      sellerUser.commission_tier = commissionInfo.level;
      sellerUser.commission_percent = commissionInfo.commission_percent;
      await sellerUser.save();
    }
    if (process.env.PAYSTACK_SECRET_KEY && sellerUser?.bank_code && sellerUser?.account_number && sellerUser?.bank_name) {
      try {
        if (!sellerUser.payout_recipient_code) {
          const recipient = await createTransferRecipient({
            name: sellerUser.account_name || sellerUser.full_name,
            account_number: sellerUser.account_number,
            bank_code: sellerUser.bank_code,
          });
          sellerUser.payout_recipient_code = recipient.recipient_code;
          sellerUser.payout_status = 'ready';
          await sellerUser.save();
        }

        const transfer = await initiateTransfer({
          amount: payoutAmount,
          recipient: sellerUser.payout_recipient_code,
          reason: `Bixcart payout for order ${order._id}`,
        });

        order.payout_status = 'sent';
        order.payout_reference = transfer.reference || transfer.id || null;
        await order.save();
      } catch (payErr) {
        sellerUser.payout_status = 'failed';
        sellerUser.payout_error = payErr.message;
        await sellerUser.save();

        order.payout_status = 'failed';
        order.payout_error = payErr.message;
        await order.save();
      }
    } else {
      sellerUser && (sellerUser.payout_status = 'not_configured');
      if (sellerUser) await sellerUser.save();
    }

    await notifyUser(String(order.seller_id), {
      title: 'Escrow released',
      body: `Your payout of ₦${payoutAmount.toLocaleString('en-NG')} has been released after successful verification.`,
      type: 'payout',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({
      success: true,
      escrow_status: 'released',
      payout_amount: payoutAmount,
      platform_fee_amount: platformFee,
      payout_status: order.payout_status,
      order: { ...order.toObject(), id: order._id },
    });
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

    // Escrow/checkout orders (paid via Paystack) must be completed through
    // confirm-delivery so the verification code is actually checked — otherwise
    // either side could mark "completed" here and skip verification entirely.
    if (outcome === 'completed' && order.payment_reference)
      return res.status(400).json({ error: 'This order needs the delivery code to be confirmed — use "Verify delivery code" instead' });

    const update = { status: outcome, escrow_status: outcome === 'completed' ? 'released' : 'cancelled' };
    if (outcome === 'completed') {
      update.buyer_marked_complete  = true;
      update.seller_marked_complete = true;
      update.released_at = new Date();
      update.platform_fee_amount = order.platform_fee_amount || Number((order.amount * 0.1).toFixed(2));
      update.seller_payout_amount = Number((order.amount - (update.platform_fee_amount || 0)).toFixed(2));
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' } });
    } else {
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'active' } });
      const buyer = await User.findById(order.buyer_id).select('email full_name').lean();
      const listing = await Listing.findById(order.listing_id).select('title').lean();
      if (buyer?.email) {
        await sendOrderRefundEmail(buyer.email, {
          buyerName: buyer.full_name || 'buyer',
          listingTitle: listing?.title || 'your item',
          reason: 'Seller did not respond within the required 6-hour window.',
        }).catch(() => {});
      }
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

    const seller = await User.findById(order.seller_id);
    const newCount = (seller.rating_count || 0) + 1;
    const newRating = (((seller.rating || 0) * (seller.rating_count || 0)) + rating) / newCount;
    const profileDelta = rating >= 4 ? 5 : rating === 3 ? 0 : -8;
    const nextHealth = Math.min(100, Math.max(0, (seller.profile_health || 100) + profileDelta));
    await User.findByIdAndUpdate(order.seller_id, {
      $set: { rating: Math.round(newRating * 10) / 10, rating_count: newCount, profile_health: nextHealth },
    });

    res.json({ success: true, profile_health: nextHealth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
