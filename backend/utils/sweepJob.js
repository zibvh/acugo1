/**
 * Bixcart AI Sweep Job
 * Runs every 26 hours — scans all active listings and recent messages
 * for policy violations and flags anything suspicious.
 */

const { Listing, Conversation, Message } = require('../db/database');
const { moderateListing, moderateMessage } = require('./aiModerator');
const { notifyUser } = require('../db/push');
const fetch = require('node-fetch');

const SWEEP_INTERVAL_MS = 26 * 60 * 60 * 1000;
const BATCH_DELAY_MS    = 5000; // 5s between API calls = ~12/min, safely under limit

let sweepRunning = false;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Call Gemini directly — bypasses keyword filter (which already runs in real-time)
async function geminiCheck(text, type) {
  if (!process.env.GEMINI_API_KEY) return { flagged: false, reason: '', category: '' };
  const PROMPT = `You are moderating content on Bixcart, an ACU student marketplace.
Flag if content contains: social handles/phone numbers to bypass platform, prohibited items (weapons/drugs/stolen goods/porn), academic fraud (exam answers/runz/expo), sexual solicitation.
Do NOT flag: price negotiation, campus meetups, bank account details, normal conversation.
${type === 'listing' ? 'This is a LISTING (title + description).' : 'This is a CHAT MESSAGE.'}
Content: "${text.slice(0, 400)}"
Respond ONLY with JSON: {"flagged":true|false,"reason":"short reason or empty","category":"contact_bypass|prohibited_item|academic_fraud|adult_content or empty"}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
    });
    if (!res.ok) { console.warn('[sweep] Gemini', res.status); return { flagged: false }; }
    const data   = await res.json();
    const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return { flagged: !!parsed.flagged, reason: parsed.reason || '', category: parsed.category || '' };
  } catch (e) { console.warn('[sweep] error:', e.message); return { flagged: false }; }
}

async function sweepListings() {
  const listings = await Listing.find({ status: 'active', ai_flagged: { $ne: true } })
    .select('_id title description category seller_id').lean();
  console.log(`[sweep] Checking ${listings.length} listings with Gemini…`);
  let flagged = 0;
  for (const l of listings) {
    const text   = `${l.title}. ${l.description}`;
    const result = await geminiCheck(text, 'listing');
    if (result.flagged) {
      flagged++;
      await Listing.findByIdAndUpdate(l._id, { $set: {
        status: 'flagged', ai_flagged: true,
        ai_flag_reason: `[Sweep] ${result.reason}`,
        ai_flag_category: result.category, ai_flagged_at: new Date(),
      }});
      notifyUser(String(l.seller_id), {
        title: '⚠️ Listing Hidden',
        body:  `"${l.title}" was flagged during routine AI sweep: ${result.reason}`,
        type:  'ai_flag',
      }).catch(() => {});
      console.log(`[sweep] Flagged listing "${l.title}": ${result.reason}`);
    }
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`[sweep] Listings done — ${flagged}/${listings.length} flagged`);
}

async function sweepMessages() {
  const since = new Date(Date.now() - SWEEP_INTERVAL_MS * 1.1);
  const messages = await Message.find({
    created_at: { $gte: since },
    is_admin_notification: { $ne: true },
    triggered_ai_flag:     { $ne: true },
  }).populate({ path: 'conversation_id', select: 'ai_flagged buyer_id seller_id' }).lean();

  const toCheck = messages.filter(m => m.conversation_id && !m.conversation_id.ai_flagged);
  console.log(`[sweep] Checking ${toCheck.length} messages with Gemini…`);
  let flagged = 0;
  for (const m of toCheck) {
    const result = await geminiCheck(m.content, 'message');
    if (result.flagged) {
      flagged++;
      const conv = m.conversation_id;
      const { Conversation } = require('../db/database');
      await Promise.all([
        Conversation.findByIdAndUpdate(conv._id, { $set: {
          ai_flagged: true, ai_flag_reason: `[Sweep] ${result.reason}`,
          ai_flag_category: result.category, ai_flagged_at: new Date(),
        }}),
        Message.findByIdAndUpdate(m._id, { $set: { triggered_ai_flag: true } }),
      ]);
      [String(conv.buyer_id), String(conv.seller_id)].forEach(uid => {
        notifyUser(uid, {
          title: '⚠️ Conversation Flagged',
          body:  `A message was flagged during routine AI sweep: ${result.reason}`,
          type:  'ai_flag',
        }).catch(() => {});
      });
      console.log(`[sweep] Flagged message in conv ${conv._id}: ${result.reason}`);
    }
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`[sweep] Messages done — ${flagged}/${toCheck.length} flagged`);
}

// ── Main sweep ────────────────────────────────────────────────────────────────
async function runSweep() {
  if (sweepRunning) { console.log('[sweep] Already running, skipping'); return; }
  sweepRunning = true;
  console.log(`[sweep] Starting AI sweep — ${new Date().toISOString()}`);
  try {
    await sweepListings();
    await sweepMessages();
    console.log(`[sweep] Sweep complete — ${new Date().toISOString()}`);
  } catch (e) {
    console.error('[sweep] Fatal error:', e.message);
  } finally {
    sweepRunning = false;
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────
function startSweepScheduler() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[sweep] GEMINI_API_KEY not set — AI sweep disabled');
    return;
  }

  // Run first sweep 2 minutes after server starts (let DB settle)
  setTimeout(runSweep, 2 * 60 * 1000);

  // Then every 26 hours
  setInterval(runSweep, SWEEP_INTERVAL_MS);

  console.log(`[sweep] Scheduler started — first sweep in 2 min, then every 26h`);
}

module.exports = { startSweepScheduler, runSweep };
