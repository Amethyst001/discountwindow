// D0 X1' + X3 — server-side card capture (no buyer login), fee field, and Payouts.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) { let v = t.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[t.slice(0, i).trim()] = v; }
  }
  return env;
}
const env = loadEnv(path.join(ROOT, '.env'));
if (!/sandbox/.test(env.PAYPAL_BASE || '')) { console.error('refusing: not sandbox'); process.exit(1); }
const OUT = path.join(ROOT, 'evidence', 'd0');
fs.mkdirSync(OUT, { recursive: true });

async function token() {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${env.PAYPAL_BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json();
  if (!r.ok) throw new Error('token ' + r.status);
  return j.access_token;
}

const [mm, yyyy] = (env.PAYPAL_TEST_CARD_EXPIRY || '11/2031').split('/');

(async () => {
  const t = await token();
  const out = { ranAt: new Date().toISOString() };

  // --- server-side card order ---
  const order = {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: 'invoice-A-1042-slice-1', description: 'Verified receivable slice', amount: { currency_code: 'USD', value: '10.00' } }],
    payment_source: {
      card: {
        number: env.PAYPAL_TEST_CARD_NUMBER,
        expiry: `${yyyy}-${mm}`,
        security_code: env.PAYPAL_TEST_CARD_CVC,
        name: 'John Doe',
        billing_address: { address_line_1: '1 Market St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' }
      }
    },
    application_context: { brand_name: 'Discount Window', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
  };
  const cr = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': 'x1c-' + Date.now() },
    body: JSON.stringify(order)
  });
  const ct = await cr.text();
  let cj = null; try { cj = JSON.parse(ct); } catch { /* raw */ }
  out.create = { status: cr.status, id: cj?.id || null, status_name: cj?.status || null, error: cj?.details?.[0] || cj?.name || (cj ? null : ct.slice(0, 500)) };

  if (cr.ok && cj?.id) {
    const pr = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders/${cj.id}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': 'cap-' + Date.now() },
      body: '{}'
    });
    const pt = await pr.text();
    let pj = null; try { pj = JSON.parse(pt); } catch { /* raw */ }
    const cap = pj?.purchase_units?.[0]?.payments?.captures?.[0];
    out.capture = {
      status: pr.status,
      order_status: pj?.status || null,
      capture_id: cap?.id || null,
      capture_status: cap?.status || null,
      amount: cap?.amount || null,
      seller_receivable_breakdown: cap?.seller_receivable_breakdown || null,
      error: pj?.details?.[0] || pj?.name || (pj ? null : pt.slice(0, 500))
    };
    fs.writeFileSync(path.join(OUT, 'x1c-capture.json'), JSON.stringify({ order: cj, capture: pj }, null, 2));
  }

  // --- Payouts ---
  const payout = {
    sender_batch_header: { sender_batch_id: 'settle-test-' + Date.now(), email_subject: 'Discount Window settlement', email_message: 'Sandbox settlement test' },
    items: [{ recipient_type: 'EMAIL', amount: { value: '1.00', currency: 'USD' }, receiver: 'dw-funder-01@example.com', note: 'Sandbox payout probe', sender_item_id: 'item-' + Date.now() }]
  };
  const par = await fetch(`${env.PAYPAL_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payout)
  });
  const pat = await par.text();
  let paj = null; try { paj = JSON.parse(pat); } catch { /* raw */ }
  out.payout = { status: par.status, batch_id: paj?.batch_header?.payout_batch_id || null, batch_status: paj?.batch_header?.batch_status || null, error: paj?.details?.[0] || paj?.name || (paj ? null : pat.slice(0, 500)) };

  fs.writeFileSync(path.join(OUT, 'x1c-x3.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
