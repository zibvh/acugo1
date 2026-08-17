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


async function listBanks({ country = 'nigeria', perPage = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ country, perPage: String(perPage), page: String(page) });
  return paystackRequest(`/bank?${params.toString()}`, { method: 'GET' });
}

async function resolveBankAccount({ account_number, bank_code, currency = 'NGN' }) {
  const params = new URLSearchParams({ account_number, bank_code, currency });
  return paystackRequest(`/bank/resolve?${params.toString()}`, { method: 'GET' });
}

async function createSubaccount({ business_name, bank_code, account_number, percentage_charge = 0, description = '', primary_contact_email = '', primary_contact_name = '', primary_contact_phone = '' }) {
  return paystackRequest('/subaccount', {
    method: 'POST',
    body: JSON.stringify({
      business_name, bank_code, account_number, percentage_charge,
      description, primary_contact_email, primary_contact_name, primary_contact_phone,
    }),
  });
}

async function createTransferRecipient({ type = 'nuban', name, account_number, bank_code, currency = 'NGN', email = '', description = '' }) {
  return paystackRequest('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify({ type, name, account_number, bank_code, currency, email, description }),
  });
}

async function initiateTransfer({ source = 'balance', amount, recipient, reference, reason = '', currency = 'NGN' }) {
  return paystackRequest('/transfer', {
    method: 'POST',
    body: JSON.stringify({ source, amount: Math.round(Number(amount) * 100), recipient, reference, reason, currency }),
  });
}

async function verifyTransfer(reference) {
  return paystackRequest(`/transfer/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
}

async function initializeTransaction(payload) {
  return paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
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

module.exports = {
  paystackRequest,
  createRefund,
  listRefunds,
  getRefund,
  verifyTransaction,
  listBanks,
  resolveBankAccount,
  createSubaccount,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
  initializeTransaction,
};
