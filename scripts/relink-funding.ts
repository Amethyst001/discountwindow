// Restores the funding state that actually ran against the PayPal sandbox on 2026-10-30.
// The order, the captures and the amounts come from evidence/published/x5-live-funding.json; nothing
// here invents a payment. Re-run it after a reseed so the demo shows a funded invoice whose
// order id a judge can look up in the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { openDb, newId, nowIso } from '../src/db.ts';
import { postFunding } from '../src/ledger.ts';
import { appendAudit } from '../src/audit.ts';
import { issueAssignmentNotice } from '../src/notice.ts';
import { ensureParty } from '../src/store.ts';

const evidencePath = path.join(ROOT, 'evidence', 'published', 'x5-live-funding.json');
const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

const db = openDb();
const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(ev.invoice.invoice_number) as any;
if (!invoice) throw new Error(`no invoice ${ev.invoice.invoice_number}; run the seed first`);
if (db.prepare('SELECT 1 FROM slices WHERE invoice_id = ?').get(invoice.id)) {
  console.log(`${invoice.invoice_number} already carries a slice; nothing to restore`);
  process.exit(0);
}

const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(invoice.id) as any;
if (!price) throw new Error('the invoice is not priced');

const unitTotal = ev.order.units.reduce((a: number, u: any) => a + Math.round(Number(u.amount) * 100), 0);
if (unitTotal !== Number(ev.slice.principal_cents)) {
  throw new Error(`evidence is inconsistent: units ${unitTotal} against slice ${ev.slice.principal_cents}`);
}

ensureParty(db, 'funders', {
  id: 'funder-demo',
  name: 'Sandbox Funder',
  paypalEmail: config.funderEmail || 'funder@example.com'
});

const sliceId = newId('sl');
db.prepare('INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES (?,?,?,?,?,?,?)')
  .run(sliceId, invoice.id, 'funder-demo', ev.slice.share_bp, ev.slice.principal_cents, 'paid', nowIso());
db.prepare('INSERT INTO commitments (id, slice_id, paypal_order_id, capture_id, capture_status, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(
    newId('cm'),
    sliceId,
    ev.order.id,
    ev.order.units.map((u: any) => u.captures[0].id).join(','),
    ev.order.units.map((u: any) => u.captures[0].status).join(','),
    Number(ev.slice.principal_cents),
    'captured',
    nowIso()
  );
db.prepare("UPDATE invoices SET status = 'funded' WHERE id = ?").run(invoice.id);
// The live flow issues the notice inside captureFunding; a reseeded book has to end in the same state
// or the demo would be missing the one document a funded receivable is supposed to produce.
issueAssignmentNotice(db, invoice.id);

postFunding(db, invoice.id, 'funder-demo', invoice.seller_id, {
  advanceCents: Number(price.advance_cents),
  platformFeeCents: Number(price.platform_fee_cents)
});
appendAudit(db, 'funding_order', invoice.id, {
  sliceId,
  orderId: ev.order.id,
  source: 'evidence/published/x5-live-funding.json',
  units: ev.order.units
});
appendAudit(db, 'funding_capture', invoice.id, {
  sliceId,
  orderId: ev.order.id,
  source: 'evidence/published/x5-live-funding.json',
  allocations: ev.order.units.map((u: any) => ({
    unit: u.ref,
    payee: u.payee,
    cents: Math.round(Number(u.amount) * 100),
    capture: u.captures[0].id,
    status: u.captures[0].status
  }))
});

console.log(`restored funding for ${invoice.invoice_number}: order ${ev.order.id}, ${ev.order.units.length} captures`);
