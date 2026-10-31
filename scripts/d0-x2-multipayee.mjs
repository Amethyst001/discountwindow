// D0 X2 — can one Orders order carry two purchase_units with different payees?
// Also attempts to provision the two sandbox personal accounts we need, since
// capture-side proof needs real payees. Sandbox only; refuses any other host.
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
if (!/sandbox/.test(env.PAYPAL_BASE || '')) { console.error('refusing: base is not sandbox'); process.exit(1); }

const OUT = path.join(ROOT, 'evidence', 'd0');
fs.mkdirSync(OUT, { recursive: true });

async function token() {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${env.PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!r.ok) throw new Error('token failed ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// Best-effort sandbox account provisioning through the legacy Adaptive Accounts API.
async function createSandboxAccount(acc) {
  const body = {
    accountType: acc.type,
    citizenshipCountryCode: 'US',
    contactPhoneNumber: '4155551234',
    currencyCode: 'USD',
    dateOfBirth: '1985-03-04Z',
    emailAddress: acc.email,
    name: { firstName: acc.first, lastName: acc.last },
    address: { line1: '1 Market St', city: 'San Jose', state: 'CA', postalCode: '95131', countryCode: 'US' },
    createAccountWebOptions: { returnUrl: 'https://example.com/return' },
    requestEnvelope: { errorLanguage: 'en_US', detailLevel: 'ReturnAll' }
  };
  const r = await fetch('https://svcs.sandbox.paypal.com/AdaptiveAccounts/CreateAccount', {
    method: 'POST',
    headers: {
      'X-PAYPAL-SECURITY-USERID': env.PAYPAL_NVP_USERNAME,
      'X-PAYPAL-SECURITY-PASSWORD': env.PAYPAL_NVP_PASSWORD,
      'X-PAYPAL-SECURITY-SIGNATURE': env.PAYPAL_NVP_SIGNATURE,
      'X-PAYPAL-REQUEST-DATA-FORMAT': 'JSON',
      'X-PAYPAL-RESPONSE-DATA-FORMAT': 'JSON',
      'X-PAYPAL-APPLICATION-ID': 'APP-80W284485P519543T',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return { email: acc.email, status: r.status, body: text.slice(0, 700) };
}

const ACCOUNTS = [
  { type: 'PERSONAL', email: 'dw-funder@example.com', first: 'Fiona', last: 'Funder' },
  { type: 'PERSONAL', email: 'dw-debtor@example.com', first: 'Dana', last: 'Debtor' },
  { type: 'BUSINESS', email: 'dw-seller@example.com', first: 'Sam', last: 'Seller' }
];

(async () => {
  const t = await token();
  const out = { ranAt: new Date().toISOString(), base: env.PAYPAL_BASE };

  out.accounts = [];
  for (const a of ACCOUNTS) out.accounts.push(await createSandboxAccount(a));

  // X2: one order, two purchase_units, two different payees.
  const order = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'seller',
        description: 'Seller advance',
        amount: { currency_code: 'USD', value: '0.90' },
        payee: { email_address: env.PAYPAL_BUSINESS_EMAIL },
        payment_instruction: { disbursement_mode: 'INSTANT' }
      },
      {
        reference_id: 'platform',
        description: 'Platform fee',
        amount: { currency_code: 'USD', value: '0.10' },
        payee: { email_address: 'dw-seller@example.com' },
        payment_instruction: { disbursement_mode: 'INSTANT' }
      }
    ],
    application_context: { brand_name: 'Discount Window', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' }
  };
  const r = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': 'x2-' + Date.now() },
    body: JSON.stringify(order)
  });
  const text = await r.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  out.x2 = { status: r.status, orderId: parsed?.id || null, link: parsed?.links?.find(l => l.rel === 'payer-action')?.href || parsed?.links?.find(l => l.rel === 'approve')?.href || null, error: parsed?.details?.[0] || parsed?.name || null, raw: parsed ? undefined : text.slice(0, 600) };

  fs.writeFileSync(path.join(OUT, 'x2.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
