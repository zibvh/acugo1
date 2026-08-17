const _fetch = globalThis.fetch || require('node-fetch');

async function paystackRequest(path, options = {}) {
  const base = 'https://api.paystack.co';
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  const res = await _fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || 'Paystack request failed');
  }

  return data.data;
}


async function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
}

async function createTransferRecipient({ name, account_number, bank_code, currency = 'NGN' }) {
  return paystackRequest('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify({ type: 'nuban', name, account_number, bank_code, currency }),
  });
}

async function createRefund({ transaction, amount, customer_note = '', merchant_note = '' }) {
  const body = { transaction };
  if (amount !== undefined && amount !== null) body.amount = Math.round(Number(amount) * 100);
  if (customer_note) body.customer_note = customer_note;
  if (merchant_note) body.merchant_note = merchant_note;
  return paystackRequest('/refund', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function listRefunds({ transaction, perPage = 100, page = 1 } = {}) {
  const params = new URLSearchParams();
  if (transaction) params.set('transaction', transaction);
  params.set('perPage', String(perPage));
  params.set('page', String(page));
  return paystackRequest(`/refund?${params.toString()}`, { method: 'GET' });
}

async function getRefund(refundId) {
  return paystackRequest(`/refund/${encodeURIComponent(refundId)}`, { method: 'GET' });
}

async function initiateTransfer({ amount, recipient, reason = 'Marketplace payout' }) {
  return paystackRequest('/transfer', {
    method: 'POST',
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(Number(amount || 0) * 100),
      recipient,
      reason,
    }),
  });
}

module.exports = {
  paystackRequest,
  createTransferRecipient,
  initiateTransfer,
  createRefund,
  listRefunds,
  getRefund,
  verifyTransaction,
};
