// Brevo HTTP API — bypasses SMTP entirely, works on Render.
// Docs: https://developers.brevo.com/reference/sendtransacemail

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function getBaseUrl() {
  const raw  = process.env.FRONTEND_URL || 'https://bixcart.onrender.com';
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  return urls.find(u => u.startsWith('https://')) || urls[urls.length - 1];
}

function parseSender(from) {
  const match = from.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from.trim() };
}

async function sendMail({ to, subject, html }) {
  const sender = parseSender(process.env.EMAIL_FROM || '"Bixcart" <bhuszibah@gmail.com>');

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key':      process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Brevo API error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  return res.json();
}

async function verifyTransport() {
  if (!process.env.BREVO_API_KEY) {
    console.error('  ✗ EMAIL FAILED — BREVO_API_KEY is not set');
    return;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const account = await res.json();
    console.log(`  ✓ Brevo ready — ${account.email}`);
  } catch (err) {
    console.error('  ✗ Brevo API check FAILED —', err.message);
  }
}

async function sendVerificationEmail(to, token) {
  const link = `${getBaseUrl()}/pages/auth.html?action=verify&token=${token}`;
  await sendMail({
    to,
    subject: 'Verify your Bixcart email',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Verify your email</h2>
        <p style="color:#555;line-height:1.6;">
          Thanks for joining Bixcart! Click the button below to confirm your email address.
          This link expires in <strong>24 hours</strong>.
        </p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#c8522a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
          Verify Email
        </a>
        <p style="color:#999;font-size:13px;">Or paste this link:<br><a href="${link}" style="color:#c8522a;">${link}</a></p>
        <p style="color:#bbb;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">
          If you didn't create a Bixcart account, ignore this email.
        </p>
      </div>`,
  });
}

async function sendPasswordResetEmail(to, token) {
  const link = `${getBaseUrl()}/pages/auth.html?action=reset&token=${token}`;
  await sendMail({
    to,
    subject: 'Reset your Bixcart password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Reset your password</h2>
        <p style="color:#555;line-height:1.6;">
          Click below to reset your Bixcart password. This link expires in <strong>1 hour</strong>.
        </p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#c8522a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
          Reset Password
        </a>
        <p style="color:#999;font-size:13px;">Or paste this link:<br><a href="${link}" style="color:#c8522a;">${link}</a></p>
        <p style="color:#bbb;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">
          If you didn't request this, your password will not change.
        </p>
      </div>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, verifyTransport };
