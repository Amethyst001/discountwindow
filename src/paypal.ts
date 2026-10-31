import { config, assertSandbox } from './config.ts';
import { toPayPalAmount, type Cents } from './money.ts';

export interface PurchaseUnitSpec {
  referenceId: string;
  description: string;
  amountCents: Cents;
  payeeEmail: string;
  /** Echoed back on every capture and dispute webhook, so an event can name its invoice. */
  customId?: string;
}

export interface Allocation {
  referenceId: string;
  payeeEmail: string;
  amountCents: Cents;
  captureId: string;
  captureStatus: string;
  sellerProtection: string | null;
}

export interface CapturedOrder {
  orderId: string;
  status: string;
  allocations: Allocation[];
  order: any;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  assertSandbox();
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`paypal token failed: ${res.status} ${JSON.stringify(body)}`);
  tokenCache = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000 };
  return tokenCache.token;
}

async function call(method: string, path: string, opts: { body?: unknown; requestId?: string; raw?: BodyInit; contentType?: string } = {}): Promise<{ status: number; body: any; text: string }> {
  assertSandbox();
  const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  else headers['Content-Type'] = 'application/json';
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
  const res = await fetch(`${config.paypalBase}${path}`, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, text };
}

export function purchaseUnitsFromSpecs(specs: PurchaseUnitSpec[]): any[] {
  return specs.map((s) => {
    const unit: any = {
      reference_id: s.referenceId,
      description: s.description.slice(0, 127),
      amount: { currency_code: 'USD', value: toPayPalAmount(s.amountCents) },
      payee: { email_address: s.payeeEmail },
      payment_instruction: { disbursement_mode: 'INSTANT' }
    };
    if (s.customId) unit.custom_id = s.customId;
    return unit;
  });
}

export async function createOrder(specs: PurchaseUnitSpec[], requestId: string): Promise<{ status: number; id: string | null; approveLink: string | null; body: any }> {
  const res = await call('POST', '/v2/checkout/orders', {
    requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: purchaseUnitsFromSpecs(specs),
      application_context: { brand_name: 'Discount Window', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
    }
  });
  const id = res.body?.id ?? null;
  const approveLink = res.body?.links?.find((l: any) => l.rel === 'payer-action')?.href
    ?? res.body?.links?.find((l: any) => l.rel === 'approve')?.href ?? null;
  return { status: res.status, id, approveLink, body: res.body };
}

export async function getOrder(orderId: string): Promise<any> {
  const res = await call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (res.status !== 200) throw new Error(`getOrder ${orderId} failed: ${res.status} ${res.text.slice(0, 300)}`);
  return res.body;
}

export async function captureOrder(orderId: string, requestId: string): Promise<CapturedOrder> {
  const res = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId, body: {} });
  // Measured 2026-10-30: a capture can move the money and still answer 500 INTERNAL_SERVICE_ERROR.
  // A second attempt on the completed order answers 500 again, so retrying is not a fix. Reconcile:
  // ask the order what happened, and only fail if it is genuinely not captured.
  if (res.status !== 201 && res.status !== 200) {
    const order = await getOrder(orderId).catch(() => null);
    if (order?.status !== 'COMPLETED') {
      throw new Error(`capture ${orderId} failed: ${res.status} ${res.text.slice(0, 400)}`);
    }
    return allocate(order, orderId);
  }
  // Measured 2026-10-30: the capture response is not the order. Its purchase_units can arrive
  // without `payee`, which is exactly the field allocation depends on. Read the order back and
  // allocate from that; the capture call itself has already moved the money.
  const order = await getOrder(orderId);
  return allocate(order, orderId);
}

export function centsFromPayPal(value: string): Cents {
  const [whole, frac = ''] = String(value).split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

/**
 * The settlement source of truth is the order's purchase_units.
 *
 * Measured 2026-10-30: GET /v2/payments/captures/{id} returns `payee` = the PAYER account, even
 * for split captures, and the capture objects inside a capture response omit both `amount` and
 * `payee`. Reading either would post every funder's slice to the wrong account while every test
 * still passed. So: payee and amount come from the unit; the capture supplies only its id and
 * status, matched to the unit by position.
 */
export function allocate(order: any, orderId: string): CapturedOrder {
  const units: any[] = order?.purchase_units ?? [];
  if (!Array.isArray(units) || units.length === 0) throw new Error('order has no purchase_units');
  const allocations: Allocation[] = [];
  for (const unit of units) {
    const captures: any[] = unit?.payments?.captures ?? [];
    if (captures.length === 0) throw new Error(`unit ${unit.reference_id} has no capture`);
    const payeeEmail: string | undefined = unit?.payee?.email_address;
    if (!payeeEmail) throw new Error(`unit ${unit.reference_id} has no payee email on the order`);
    const amountCents = centsFromPayPal(unit?.amount?.value ?? '0');
    for (const capture of captures) {
      const related = capture?.supplementary_data?.related_ids?.order_id;
      if (related && related !== orderId) {
        throw new Error(`capture ${capture.id} belongs to order ${related}, not ${orderId}`);
      }
      allocations.push({
        referenceId: unit.reference_id,
        payeeEmail,
        amountCents,
        captureId: capture.id,
        captureStatus: capture.status,
        sellerProtection: capture?.seller_protection?.status ?? null
      });
    }
  }
  return { orderId, status: order.status, allocations, order };
}

/**
 * The rail's own answer for each capture, in the order the capture ids are stored, so the two columns
 * stay one list read side by side. A desk that wrote a single "captured" over a unit that cleared and
 * a unit still in flight would be reporting a settlement that has not happened.
 */
export function captureStatusList(captured: CapturedOrder): string {
  return captured.allocations.map((a) => a.captureStatus).join(',');
}

export async function getCapture(captureId: string): Promise<any> {
  const res = await call('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  if (res.status !== 200) throw new Error(`getCapture ${captureId} failed: ${res.status}`);
  return res.body;
}

export async function verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  if (!config.webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');
  const res = await call('POST', '/v1/notifications/verify-webhook-signature', {
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.webhookId,
      webhook_event: event
    }
  });
  return { ok: res.body?.verification_status === 'SUCCESS', status: res.status, body: res.body };
}
