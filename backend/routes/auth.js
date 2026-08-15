const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { User, Order, Listing, Waitlist } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, full_name: user.full_name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function safeUser(u) {
  const obj = u.toObject ? u.toObject() : { ...u };
  delete obj.password_hash;
  delete obj.email_verify_token;
  delete obj.email_verify_expires;
  delete obj.password_reset_token;
  delete obj.password_reset_expires;
  obj.id = obj._id;
  return obj;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

const PASSWORD_MIN = 8;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

function validatePassword(password) {
  if (!password || password.length < PASSWORD_MIN)
    return `Password must be at least ${PASSWORD_MIN} characters`;
  if (!PASSWORD_REGEX.test(password))
    return 'Password must contain uppercase, lowercase, and a number';
  return null;
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, confirm_password, full_name, role } = req.body;

    if (!email || !password || !confirm_password || !full_name || !role)
      return res.status(400).json({ error: 'All fields are required' });

    if (!['buyer', 'seller'].includes(role))
      return res.status(400).json({ error: 'Role must be buyer or seller' });

    // Password strength
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    // Confirm password
    if (password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const verifyToken   = randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // First 50 sellers OR waitlisted emails get 6 free listing credits
    let listingCredits = 0;
    if (role === 'seller') {
      const [sellerCount, onWaitlist] = await Promise.all([
        User.countDocuments({ role: 'seller' }),
        Waitlist.findOne({ email: email.toLowerCase() }).lean(),
      ]);
      listingCredits = (sellerCount < 50 || onWaitlist) ? 6 : 1;
    }

    const user = await User.create({
      email: email.toLowerCase(),
      full_name,
      role,
      password_hash:         bcrypt.hashSync(password, 12),
      listing_credits:       listingCredits,
      registration_complete: false,
      email_verified:        false,
      email_verify_token:    verifyToken,
      email_verify_expires:  verifyExpires,
    });

    // Send verification email — non-blocking so registration still succeeds,
    // but errors are logged clearly so you can diagnose SMTP issues in Render logs
    sendVerificationEmail(user.email, verifyToken).catch(err => {
      console.error('[email] VERIFICATION EMAIL FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json({
      token: signToken(user),
      user: safeUser(user),
      message: 'Account created. Please check your email to verify your address.',
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    if (user.account_status === 'suspended')
      return res.status(403).json({ error: 'Your account has been suspended. Contact support for assistance.' });

    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/verify-email?token=… ──────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const user = await User.findOne({
      email_verify_token:   token,
      email_verify_expires: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Verification link is invalid or has expired' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        email_verified:       true,
        email_verify_token:   null,
        email_verify_expires: null,
      },
    });

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/resend-verification ──────────────────────────────────────
router.post('/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always respond the same to prevent user enumeration
    if (!user || user.email_verified) {
      return res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
    }

    const verifyToken   = randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(user._id, {
      $set: { email_verify_token: verifyToken, email_verify_expires: verifyExpires },
    });

    sendVerificationEmail(user.email, verifyToken).catch(err => {
      console.error('[email] RESEND VERIFICATION FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always same response to prevent user enumeration
    const genericMsg = { message: 'If that email is registered, a password reset link has been sent.' };

    if (!user) return res.json(genericMsg);

    const resetToken   = randomToken();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_reset_token:   resetToken,
        password_reset_expires: resetExpires,
      },
    });

    sendPasswordResetEmail(user.email, resetToken).catch(err => {
      console.error('[email] PASSWORD RESET EMAIL FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json(genericMsg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    if (!token || !password || !confirm_password)
      return res.status(400).json({ error: 'All fields are required' });

    if (password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match' });

    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = await User.findOne({
      password_reset_token:   token,
      password_reset_expires: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_hash:          bcrypt.hashSync(password, 12),
        password_reset_token:   null,
        password_reset_expires: null,
      },
    });

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/vapid-public-key ──────────────────────────────────────────
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(404).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// ─── GET /api/auth/paystack-public-key ───────────────────────────────────────
router.get('/paystack-public-key', (req, res) => {
  const key = process.env.PAYSTACK_PUBLIC_KEY;
  if (!key) return res.status(500).json({ error: 'Paystack not configured' });
  res.json({ publicKey: key });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password_hash -email_verify_token -password_reset_token');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/auth/complete-registration ─────────────────────────────────────
router.put('/complete-registration', authMiddleware, async (req, res) => {
  try {
    const { full_name, business_name, id_type, id_front_url, id_back_url } = req.body;

    if (!full_name || !id_type || !id_front_url || !id_back_url)
      return res.status(400).json({ error: 'Full name, ID type and both ID photos are required' });

    const update = { full_name, id_type, id_front_url, id_back_url, registration_complete: true };
    if (business_name !== undefined) update.business_name = business_name;

    const user = await User.findByIdAndUpdate(
      req.user.id, { $set: update }, { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');

    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/auth/profile ────────────────────────────────────────────────────
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { full_name, bio, business_name, university, location, avatar_url, banner_url } = req.body;
    const update = { full_name, bio };
    if (business_name !== undefined) update.business_name = business_name;
    if (university   !== undefined) update.university     = university;
    if (location     !== undefined) update.location       = location;
    if (avatar_url   !== undefined) update.avatar_url     = avatar_url;
    if (banner_url   !== undefined) update.banner_url     = banner_url;
    const user = await User.findByIdAndUpdate(
      req.user.id, { $set: update }, { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/auth/change-password ───────────────────────────────────────────
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password)
      return res.status(400).json({ error: 'All fields are required' });

    if (new_password !== confirm_password)
      return res.status(400).json({ error: 'New passwords do not match' });

    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!bcrypt.compareSync(current_password, user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });

    user.password_hash = bcrypt.hashSync(new_password, 12);
    await user.save();

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/admin-messages ────────────────────────────────────────────
// Returns unacknowledged admin messages. Does NOT mark them as read/acknowledged —
// that only happens when the user explicitly presses the acknowledge button
// (see POST /admin-messages/:id/ack below), so a message can't be silently
// consumed just by the app fetching it in the background.
router.get('/admin-messages', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('admin_messages');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const unacknowledged = (user.admin_messages || []).filter(m => !m.acknowledged);

    res.json({
      messages: unacknowledged.map(m => ({
        id:      m._id,
        title:   m.title || '',
        content: m.content,
        sent_at: m.sent_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/admin-messages/:id/ack ───────────────────────────────────
// Marks a single admin message as acknowledged. Called only when the user
// presses the "I've read this" button on the popup.
router.post('/admin-messages/:id/ack', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('admin_messages');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const msg = user.admin_messages.id(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    msg.acknowledged = true;
    msg.acknowledged_at = new Date();
    msg.read = true;
    await user.save();

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/credits/verify ───────────────────────────────────────────
router.post('/credits/verify', authMiddleware, async (req, res) => {
  try {
    const { reference, credits } = req.body;
    if (!reference) return res.status(400).json({ error: 'reference required' });

    const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

    const paystackRes  = await _fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const paystackData = await paystackRes.json();

    console.log('[credits/verify] Paystack response:', JSON.stringify(paystackData));

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      console.error('[credits/verify] Not verified. status:', paystackData.data?.status, 'msg:', paystackData.message);
      return res.status(400).json({ error: 'Payment not verified: ' + (paystackData.message || paystackData.data?.gateway_response || 'unknown') });
    }

    const existing = await User.findOne({ used_payment_refs: reference });
    if (existing) return res.status(409).json({ error: 'Payment reference already used' });

    const CREDIT_TIERS = [
      { amountKobo: 60000,   credits: 1  },
      { amountKobo: 190000,  credits: 3  },
      { amountKobo: 600000,  credits: 10 },
      { amountKobo: 1650000, credits: 30 },
    ];
    const paidAmount  = paystackData.data.amount;
    const tier        = CREDIT_TIERS.find(t => t.amountKobo === paidAmount);
    const creditAmount = tier ? tier.credits : (credits ? parseInt(credits) : null);

    console.log('[credits/verify] paidAmount:', paidAmount, 'creditAmount:', creditAmount);

    if (!creditAmount || creditAmount < 1)
      return res.status(400).json({ error: 'Could not determine credits for this payment amount (paid: ' + paidAmount + ' kobo)' });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { listing_credits: creditAmount }, $addToSet: { used_payment_refs: reference } },
      { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');

    console.log('[credits/verify] Success. New balance:', user.listing_credits);
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) {
    console.error('[credits/verify] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/waitlist — join the waitlist (earns 6 listing credits on signup)
router.post('/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    const normalised = email.toLowerCase().trim();
    // Check already registered
    const existing = await User.findOne({ email: normalised });
    if (existing) return res.status(409).json({ error: 'already_registered' });
    // Upsert into waitlist
    await Waitlist.findOneAndUpdate(
      { email: normalised },
      { email: normalised },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/seller-count — public, for first-50 badge display
router.get('/seller-count', async (req, res) => {
  try {
    const count = await User.countDocuments({ role: 'seller' });
    res.json({ count, bonus_available: count < 50 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/users/:id/profile — public profile (no auth required)
router.get('/users/:id/profile', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('full_name avatar_url bio university role rating rating_count business_name created_at account_status')
      .lean();
    if (!user || user.account_status === 'suspended') return res.status(404).json({ error: 'User not found' });

    let extra = {};
    if (user.role === 'seller') {
      const listings = await Listing.find({ seller_id: user._id, status: { $ne: 'deleted' } })
        .select('title images price category status views').sort({ created_at: -1 }).limit(12).lean();
      const completedOrders = await Order.countDocuments({ seller_id: user._id, status: 'completed' });
      const reviews = await Order.find({ seller_id: user._id, buyer_rating: { $ne: null } })
        .populate('buyer_id', 'full_name avatar_url')
        .select('buyer_rating buyer_review buyer_rated_at buyer_id')
        .sort({ buyer_rated_at: -1 }).limit(10).lean();
      extra = { listings, completed_sales: completedOrders, reviews };
    } else {
      const purchases = await Order.countDocuments({ buyer_id: user._id, status: 'completed' });
      const reviews = await Order.find({ buyer_id: user._id, buyer_rating: { $ne: null } })
        .populate('listing_id', 'title')
        .select('buyer_rating buyer_review buyer_rated_at listing_id')
        .sort({ buyer_rated_at: -1 }).limit(10).lean();
      extra = { purchases, reviews };
    }

    res.json({ ...user, id: user._id, ...extra });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
