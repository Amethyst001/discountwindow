// Creates a real sandbox dispute as the buyer who paid, so PayPal delivers a genuinely signed
// CUSTOMER.DISPUTE.CREATED to the registered webhook. This is the X4 dispute experiment:
// the app must freeze the matching invoice and ignore a forged copy of the same event.
//
// Usage: node scripts/d0-dispute.ts <capture-id> [amount]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, assertSandbox } from '../src/config.ts';

const captureId = process.argv[2];
const amountArg = process.argv[3] ?? '520.00';
if (!captureId) throw new Error('pass the capture id of the funding payment as the first argument');
assertSandbox();

async function token(): Promise<string> {
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`oauth ${res.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

async function api(method: string, route: string, accessToken: string, init: { json?: unknown; raw?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (init.raw !== undefined) headers['Content-Type'] = init.contentType ?? 'application/json';
  const res = await fetch(`${config.paypalBase}${route}`, {
    method,
    headers,
    body: init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json))
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

/** The assertion says "this call is the buyer's". PayPal checks the payer id in the token. */
function authAssertion(payerId: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ iss: config.clientId, payer_id: payerId })}.`;
}

const accessToken = await token();
const out: Record<string, any> = { ranAt: new Date().toISOString(), captureId };

const capture = await api('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, accessToken);
// Measured 2026-10-30: a capture of a split order carries no `payer` block. The order it belongs
// to does, so the buyer id is read from the order the capture links back to.
const orderHref: string | undefined = capture.body?.links?.find((l: any) => l.rel === 'up')?.href;
const orderId = orderHref ? orderHref.split('/').pop() : null;
const order = orderId ? await api('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, accessToken) : null;
const payerId: string | null = order?.body?.payer?.payer_id ?? null;
out.capture = {
  status: capture.status,
  outcome: capture.body,
  orderId,
  payerId,
  payerEmail: order?.body?.payer?.email_address ?? null,
  amount: capture.body?.amount ?? null
};
if (!payerId) {
  console.error(JSON.stringify(out, null, 2));
  throw new Error('the order for this capture has no payer_id, so no buyer assertion can be made');
}

const input = {
  disputed_transactions: [{ buyer_transaction_id: captureId }],
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  dispute_amount: { currency_code: 'USD', value: amountArg },
  extensions: {
    merchant_contacted: true,
    merchant_contacted_outcome: 'NO_RESPONSE',
    merchandize_dispute_properties: { issue_type: 'PRODUCT' }
  }
};
// Measured on 2026-10-30: the create-dispute endpoint takes multipart with the JSON in `input`.
const boundary = `----dw${Date.now()}`;
const multipart = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="input"',
  'Content-Type: application/json',
  '',
  JSON.stringify(input),
  `--${boundary}--`,
  ''
].join('\r\n');

const res = await fetch(`${config.paypalBase}/v1/customer/disputes`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'PayPal-Auth-Assertion': authAssertion(payerId)
  },
  body: multipart
});
const text = await res.text();
let body: any = null;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
out.create = { status: res.status, body, sent: input };
console.log(JSON.stringify(out.create, null, 2));

fs.mkdirSync(path.join(ROOT, 'evidence', 'd0'), { recursive: true });
const file = path.join(ROOT, 'evidence', 'd0', 'x4-dispute.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`saved ${file}`);
