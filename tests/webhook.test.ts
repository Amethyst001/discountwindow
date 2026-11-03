import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, nowIso } from '../src/db.ts';
import { resolveWebhookInvoice, freezeForDispute, releaseFreeze } from '../src/store.ts';
import { handleWebhook } from '../src/webhook.ts';

// A minimal book: one invoice, one slice, one commitment, one maturity order.
function fixture() {
  const db = openDb(':memory:');
  const at = nowIso();
  db.prepare("INSERT INTO sellers (id, paypal_merchant_id, legal_name, country, created_at) VALUES ('s1','seller@example.com','Northwind','US',?)").run(at);
  db.prepare("INSERT INTO debtors (id, legal_name, normalized_name, billing_address_json, limit_cents, created_at) VALUES ('d1','Halcyon','halcyon','{}',1000000,?)").run(at);
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Sandbox Funder','funder@example.com',?)").run(at);
  db.prepare(`INSERT INTO invoices (id, invoice_number, seller_id, debtor_id, face_cents, currency, issued_on, due_on, status, created_at)
              VALUES ('inv_1','NW-1','s1','d1',65000,'USD','2026-10-01','2026-11-30','funded',?)`).run(at);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl_1','inv_1','f1',10000,49301,'paid',?)").run(at);
  db.prepare("INSERT INTO commitments (id, slice_id, paypal_order_id, amount_cents, status, capture_id, created_at) VALUES ('cm_1','sl_1','ORDER-FUND',51823,'captured','CAP1,CAP2',?)").run(at);
  db.prepare(`INSERT INTO maturity_orders (id, invoice_id, paypal_order_id, approve_link, funder_id, gross_funder_cents, gross_seller_cents, status, created_at)
              VALUES ('mo_1','inv_1','ORDER-MATURE',NULL,'f1',52000,13000,'created',?)`).run(at);
  return db;
}

test('a dispute resolves by unit custom_id', () => {
  const db = fixture();
  const r = resolveWebhookInvoice(db, { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { custom_id: 'inv_1' } });
  assert.deepEqual(r, { invoiceId: 'inv_1', via: 'resource.custom_id' });
});

test('a dispute resolves by the capture id it names, when no custom_id survives', () => {
  const db = fixture();
  const r = resolveWebhookInvoice(db, {
    event_type: 'CUSTOMER.DISPUTE.CREATED',
    resource: { disputed_transactions: [{ seller_transaction_id: 'CAP2' }] }
  });
  assert.deepEqual(r, { invoiceId: 'inv_1', via: 'capture CAP2' });
});

test('a capture event resolves through the order it belongs to', () => {
  const db = fixture();
  const maturity = resolveWebhookInvoice(db, { resource: { supplementary_data: { related_ids: { order_id: 'ORDER-MATURE' } } } });
  assert.deepEqual(maturity, { invoiceId: 'inv_1', via: 'related order (maturity)' });
  const funding = resolveWebhookInvoice(db, { resource: { supplementary_data: { related_ids: { order_id: 'ORDER-FUND' } } } });
  assert.deepEqual(funding, { invoiceId: 'inv_1', via: 'related order (funding)' });
});

test('an event that names nothing we hold resolves to nothing, never to a guess', () => {
  const db = fixture();
  assert.equal(resolveWebhookInvoice(db, { resource: { custom_id: 'inv-does-not-exist' } }), null);
  assert.equal(resolveWebhookInvoice(db, { resource: { disputed_transactions: [{ seller_transaction_id: 'CAP9' }] } }), null);
  assert.equal(resolveWebhookInvoice(db, { resource: {} }), null);
  assert.equal(resolveWebhookInvoice(db, {}), null);
});

test('a verified dispute freezes a live position and records why', () => {
  const db = fixture();
  const result = freezeForDispute(db, 'inv_1', { eventId: 'WH-1', via: 'resource.custom_id' });
  assert.equal(result.frozen, true);
  assert.equal(result.previousStatus, 'funded');
  const invoice = db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any;
  assert.equal(invoice.status, 'disputed');
  const audit = db.prepare("SELECT payload_json FROM audit_log WHERE kind = 'dispute_freeze'").get() as any;
  assert.match(audit.payload_json, /resource\.custom_id/);
});

test('a second dispute is a no-op: a frozen position does not change again', () => {
  const db = fixture();
  freezeForDispute(db, 'inv_1', { eventId: 'WH-1' });
  const again = freezeForDispute(db, 'inv_1', { eventId: 'WH-2' });
  assert.equal(again.frozen, false);
  assert.equal(again.previousStatus, 'disputed');
  const rows = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'dispute_freeze'").get() as any;
  assert.equal(Number(rows.n), 1);
});

test('a settled invoice has nothing left to freeze', () => {
  const db = fixture();
  db.prepare("UPDATE invoices SET status = 'settled' WHERE id = 'inv_1'").run();
  const result = freezeForDispute(db, 'inv_1', { eventId: 'WH-3' });
  assert.equal(result.frozen, false);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'settled');
});

test('a refund event resolves to its invoice through the capture link', () => {
  const db = fixture();
  // The shape a real PAYMENT.CAPTURE.REFUNDED carries: the refund id, and a link up to the capture.
  const refund = {
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: {
      id: 'REFUND-1',
      links: [
        { rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP2', method: 'GET' },
        { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND-1' }
      ]
    }
  };
  assert.deepEqual(resolveWebhookInvoice(db, refund), { invoiceId: 'inv_1', via: 'capture CAP2' });
});

test('a resolution releases the freeze back to the status it held', () => {
  const db = fixture();
  freezeForDispute(db, 'inv_1', { eventId: 'WH-1', via: 'resource.custom_id' });
  const released = releaseFreeze(db, 'inv_1', { eventId: 'WH-2' });
  assert.equal(released.restoredTo, 'funded');
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'funded');
  const audit = db.prepare("SELECT kind, payload_json FROM audit_log WHERE kind = 'dispute_release'").get() as any;
  assert.match(audit.payload_json, /"to":"funded"/);
});

test('a resolution on an invoice that was never frozen changes nothing', () => {
  const db = fixture();
  const released = releaseFreeze(db, 'inv_1', { eventId: 'WH-4' });
  assert.equal(released.restoredTo, null);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'funded');
});

test('a clawback recorded on a frozen position is written down even though the status cannot change', () => {
  const db = fixture();
  freezeForDispute(db, 'inv_1', { eventId: 'WH-1', kind: 'CUSTOMER.DISPUTE.CREATED' });
  const again = freezeForDispute(db, 'inv_1', { eventId: 'WH-2', kind: 'PAYMENT.CAPTURE.REVERSED' });
  assert.equal(again.frozen, false);
  const rows = db.prepare("SELECT payload_json FROM audit_log WHERE kind = 'dispute_freeze' ORDER BY seq").all() as any[];
  assert.equal(rows.length, 2);
  assert.match(String(rows[1].payload_json), /PAYMENT\.CAPTURE\.REVERSED/);
  assert.match(String(rows[1].payload_json), /"recordedOnly":true/);
});

test('a dispute resolved after the money came back does not unfreeze the position', () => {
  const db = fixture();
  freezeForDispute(db, 'inv_1', { eventId: 'WH-1', kind: 'CUSTOMER.DISPUTE.CREATED' });
  freezeForDispute(db, 'inv_1', { eventId: 'WH-2', kind: 'PAYMENT.CAPTURE.REFUNDED' });
  const released = releaseFreeze(db, 'inv_1', { eventId: 'WH-3' });
  assert.equal(released.restoredTo, null);
  assert.equal(released.heldForClawback, true);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'disputed');
  const releases = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'dispute_release'").get() as any;
  assert.equal(Number(releases.n), 0, 'a position held for a clawback is not released, so no release is booked');
  const held = db.prepare("SELECT payload_json FROM audit_log WHERE kind = 'dispute_release_held'").get() as any;
  assert.match(String(held.payload_json), /PAYMENT\.CAPTURE\.REFUNDED/);
});

test('a refund that froze the position directly also blocks a later release', () => {
  const db = fixture();
  freezeForDispute(db, 'inv_1', { eventId: 'WH-1', kind: 'PAYMENT.CAPTURE.REFUNDED' });
  const released = releaseFreeze(db, 'inv_1', { eventId: 'WH-2' });
  assert.equal(released.heldForClawback, true);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'disputed');
});

// ---- The intake rules, tested without a network ------------------------------------------------

const dispute = (id: string) => ({
  id,
  event_type: 'CUSTOMER.DISPUTE.CREATED',
  resource: { custom_id: 'inv_1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' }
});

test('a body with no event id is refused, not stored', () => {
  const db = fixture();
  const out = handleWebhook(db, { event: { event_type: 'CUSTOMER.DISPUTE.CREATED' }, raw: '{}', verification: { kind: 'verified' } });
  assert.equal(out.status, 400);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n), 0);
});

test('a verification that could not be made answers 503 and stores nothing, so the retry is not a duplicate', () => {
  const db = fixture();
  const out = handleWebhook(db, { event: dispute('WH-1'), raw: '{}', verification: { kind: 'error', message: 'network down' } });
  assert.equal(out.status, 503);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n), 0);

  // PayPal resends the same id; this time the check answers, and the freeze happens.
  const retry = handleWebhook(db, { event: dispute('WH-1'), raw: '{}', verification: { kind: 'verified' } });
  assert.equal(retry.status, 200);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'disputed');
});

test('a definite signature failure is stored as evidence, and a later verified delivery of the same id still runs', () => {
  const db = fixture();
  const failed = handleWebhook(db, { event: dispute('WH-2'), raw: '{}', verification: { kind: 'failed' } });
  assert.equal(failed.status, 200);
  const row = db.prepare('SELECT verified, processed_at FROM webhook_events WHERE event_id = ?').get('WH-2') as any;
  assert.equal(row.verified, 0);
  assert.equal(row.processed_at, null);

  const verified = handleWebhook(db, { event: dispute('WH-2'), raw: '{}', verification: { kind: 'verified' } });
  assert.equal(verified.status, 200);
  const after = db.prepare('SELECT verified, processed_at FROM webhook_events WHERE event_id = ?').get('WH-2') as any;
  assert.equal(after.verified, 1);
  assert.ok(after.processed_at);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'disputed');
});

test('a verified event that already processed is a duplicate and does not freeze twice', () => {
  const db = fixture();
  handleWebhook(db, { event: dispute('WH-3'), raw: '{}', verification: { kind: 'verified' } });
  handleWebhook(db, { event: dispute('WH-3'), raw: '{}', verification: { kind: 'verified' } });
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'dispute_freeze'").get() as any).n), 1);
});

test('unverified rows are capped, oldest first', () => {
  const db = fixture();
  for (let i = 0; i < 205; i++) {
    handleWebhook(db, { event: dispute(`JUNK-${i}`), raw: '{}', verification: { kind: 'failed' } });
  }
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n);
  assert.equal(n, 200);
  const oldest = db.prepare('SELECT event_id FROM webhook_events ORDER BY received_at, rowid LIMIT 1').get() as any;
  assert.notEqual(oldest.event_id, 'JUNK-0', 'the oldest junk row was evicted');
});
