// Registers a sandbox webhook against a public URL and asks PayPal to deliver a real event to it.
// This is the X4 experiment: the app must reject an unsigned body and accept a signed delivery.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, assertSandbox } from '../src/config.ts';

const publicUrl = process.argv[2];
const mode = process.argv[3] ?? 'register';
if (!publicUrl?.startsWith('https://')) throw new Error('pass the public https URL as the first argument');
assertSandbox();

async function token(): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`oauth ${res.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

async function api(method: string, route: string, accessToken: string, payload?: unknown) {
  const res = await fetch(`${config.paypalBase}${route}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const accessToken = await token();
const out: Record<string, any> = { ranAt: new Date().toISOString(), publicUrl, mode };

if (mode === 'register') {
  const created = await api('POST', '/v1/notifications/webhooks', accessToken, {
    url: `${publicUrl}/webhooks/paypal`,
    event_types: [
      { name: 'CUSTOMER.DISPUTE.CREATED' },
      { name: 'CUSTOMER.DISPUTE.RESOLVED' },
      { name: 'PAYMENT.CAPTURE.COMPLETED' },
      { name: 'PAYMENT.CAPTURE.DENIED' },
      { name: 'PAYMENT.CAPTURE.REFUNDED' }
    ]
  });
  out.register = created;
  if (created.status !== 201) {
    console.error(JSON.stringify(created, null, 2));
    process.exit(1);
  }
  console.log(`webhook ${created.body.id} -> ${publicUrl}/webhooks/paypal`);
  // Put the id where the app reads it. The file is gitignored; the value is not a secret.
  const envPath = path.join(ROOT, '.env');
  const line = `PAYPAL_WEBHOOK_ID=${created.body.id}`;
  const current = fs.readFileSync(envPath, 'utf8').split('\n').filter((l) => !l.startsWith('PAYPAL_WEBHOOK_ID='));
  current.push(line);
  fs.writeFileSync(envPath, current.join('\n'));
  console.log(`wrote ${line} to .env; restart the server so it picks the id up`);
} else if (mode === 'simulate') {
  // Measured 2026-10-30: simulate-event accepts webhook_id + event_type + resource_version and
  // delivers a signed sample, but rejects any `resource` we supply (400 MALFORMED /resource) for
  // every shape tried, so the sample cannot be aimed at one invoice. Invoice targeting has to
  // come from a real PayPal action instead.
  const simulated = await api('POST', '/v1/notifications/simulate-event', accessToken, {
    event_type: process.argv[4] ?? 'PAYMENT.CAPTURE.COMPLETED',
    webhook_id: config.webhookId,
    resource_version: '1.0'
  });
  out.simulate = simulated;
  console.log(JSON.stringify(simulated, null, 2));
}

fs.mkdirSync(path.join(ROOT, 'evidence', 'd0'), { recursive: true });
const file = path.join(ROOT, 'evidence', 'd0', mode === 'register' ? 'x4-register.json' : 'x4-simulate.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`saved ${file}`);
