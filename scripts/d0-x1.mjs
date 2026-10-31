import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const BASE = env.PAYPAL_BASE;
if (!BASE || !BASE.includes('sandbox')) throw new Error('refusing non-sandbox base: ' + BASE);
const auth = 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');

const scrub = (s) => String(s).split(env.PAYPAL_CLIENT_SECRET).join('[secret]').split(env.PAYPAL_CLIENT_ID).join('[client]').slice(0, 600);

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`token ${r.status}: ${scrub(t)}`);
  return JSON.parse(t);
}

const outDir = path.join(ROOT, 'evidence', 'd0');
fs.mkdirSync(outDir, { recursive: true });
const report = { ranAt: new Date().toISOString(), base: BASE, steps: {} };

const tok = await token();
report.steps.token = { ok: true, app_id: tok.app_id, expires_in: tok.expires_in, scope: tok.scope };
console.log('X1 token: ok  app_id=' + tok.app_id + '  scopes=' + tok.scope.split(' ').length);

const headers = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };

const ui = await fetch(`${BASE}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers });
const uiBody = await ui.json();
report.steps.identity = { status: ui.status, payer_id: uiBody.payer_id, email: uiBody.email, name: uiBody.name, country: uiBody.address && uiBody.address.country_code };
console.log('X1 identity:', ui.status, 'payer_id=' + uiBody.payer_id, 'country=' + (uiBody.address && uiBody.address.country_code));

const reqId = 'x1-' + Date.now();
const orderRes = await fetch(`${BASE}/v2/checkout/orders`, {
  method: 'POST',
  headers: { ...headers, 'PayPal-Request-Id': reqId, Prefer: 'return=representation' },
  body: JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'x1',
      description: 'D0 baseline order',
      amount: { currency_code: 'USD', value: '1.00' },
    }],
    application_context: {
      brand_name: 'Discount Window Sandbox',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: 'https://example.com/return',
      cancel_url: 'https://example.com/cancel',
    },
  }),
});
const order = await orderRes.json();
report.steps.createOrder = {
  status: orderRes.status,
  id: order.id,
  state: order.status,
  links: order.links,
  request_id: reqId,
};
console.log('X1 create:', orderRes.status, order.id, order.status);
const approve = (order.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
console.log('X1 approval link:', approve ? approve.href : 'none');

fs.writeFileSync(path.join(outDir, 'x1.json'), JSON.stringify({ report, raw: { order } }, null, 2));
console.log('\nwritten evidence/d0/x1.json');
console.log('NEXT: capture needs a sandbox buyer login. Payer approval URL is above.');
