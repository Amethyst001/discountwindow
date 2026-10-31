// Reads the live status of the sandbox captures this demo has funded, and reports whether each is
// refundable. PayPal only reverses a COMPLETED capture, so this decides whether the refund branch
// can be shown with real money movement or stays a signed-fixture path.
import { config, assertSandbox } from '../src/config.ts';

assertSandbox();

const captures = process.argv.slice(2).filter((a) => /^[A-Z0-9]{14,20}$/.test(a));
if (captures.length === 0) throw new Error('pass one or more capture ids');

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

const accessToken = await token();
for (const id of captures) {
  const res = await fetch(`${config.paypalBase}/v2/payments/captures/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await res.json() as any;
  if (!res.ok) {
    console.log(`${id} -> HTTP ${res.status} ${j?.details?.[0]?.issue ?? ''} ${j?.message ?? ''}`);
    continue;
  }
  const refunds = (j.refund_detail ?? {}) as any;
  console.log(
    `${id} status=${j.status} amount=${j.amount?.currency_code} ${j.amount?.value}` +
    ` seller=${j.seller_payable_amount?.value ?? '-'} sp=${j.seller_protection?.status ?? '-'}` +
    ` refunded=${refunds.refund_amount?.value ?? '0.00'} refundable=${j.status === 'COMPLETED' && Number(refunds.refundable_amount?.value ?? 0) > 0}`
  );
  for (const r of refunds.refunds ?? []) console.log(`   refund ${r.id} ${r.status} ${r.amount?.value}`);
}
