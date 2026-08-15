const crypto = require('crypto');

function generateVerificationCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let i = 0; i < length; i += 1) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }

  return code;
}

function normalizeCode(value) {
  return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function verifyEscrowCode(candidate, expected) {
  return normalizeCode(candidate) === normalizeCode(expected);
}

function calculatePayout(amount, platformFeePercent = 3, flatFee = 300) {
  const value = Number(amount || 0);
  const feePercent = Number(platformFeePercent || 0);
  const fee = (value * (feePercent / 100)) + Number(flatFee || 0);
  const payout = Math.max(0, value - fee);
  return Number(payout.toFixed(2));
}

module.exports = {
  generateVerificationCode,
  normalizeCode,
  verifyEscrowCode,
  calculatePayout,
};
