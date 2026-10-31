// X1/X2 variant: payees are US personal accounts created via Adaptive Accounts,
// to isolate whether PAYEE_ACCOUNT_LOCKED_OR_CLOSED is specific to the NG business merchant.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) { let v = t.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[t.slice(0, i).trim()] = v; }
}
if (!/sandbox/.test(env.PAYPAL_BASE || '')) { console.error('not sandbox'); process.exit(1); }

const tok = await (async () => {
  const b = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${env.PAYPAL_BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${b}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  return (await r.json()).access_token;
})();

async function createOrder(label, units, requestId) {
  const body = { intent: 'CAPTURE', purchase_units: units, application_context: { brand_name: 'Discount Window', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } };
  const r = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* raw */ }
  return {
    label, status: r.status, id: j?.id || null, orderState: j?.status || null,
    link: j?.links?.find(l => l.rel === 'payer-action')?.href || j?.links?.find(l => l.rel === 'approve')?.href || null,
    error: j?.details?.[0] || j?.name || (j ? null : text.slice(0, 400))
  };
}

const A = 'dw-funder-01@example.com';
const B = 'dw-funder-02@example.com';
const ts = Date.now();

const one = await createOrder('one-payee-us-personal', [
  { reference_id: 'slice-1', description: 'Invoice A-1042 slice', amount: { currency_code: 'USD', value: '1.00' }, payee: { email_address: B } }
], 'dc-us-single-' + ts);

const two = await createOrder('two-payee-us-personal', [
  { reference_id: 'seller', description: 'Seller advance', amount: { currency_code: 'USD', value: '0.90' }, payee: { email_address: A }, payment_instruction: { disbursement_mode: 'INSTANT' } },
  { reference_id: 'platform', description: 'Platform fee', amount: { currency_code: 'USD', value: '0.10' }, payee: { email_address: B }, payment_instruction: { disbursement_mode: 'INSTANT' } }
], 'dc-us-split-' + ts);

const out = { ranAt: new Date().toISOString(), buyer: env.PAYPAL_FUNDER_EMAIL, payees: { A, B }, orders: [one, two] };
fs.writeFileSync(path.join(ROOT, 'evidence', 'd0', 'x2-orders-us.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
