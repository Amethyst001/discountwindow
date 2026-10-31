import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.ts';
import { intakeInvoice, type CreateInvoiceInput } from '../src/store.ts';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const SELLER = { id: 's1', name: 'Northwind Components LLC', country: 'US' };
const DEBTOR = {
  id: 'd1',
  name: 'Halcyon Retail Group',
  billingAddress: { line1: '4400 Congress Avenue', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
  limitCents: 30_000_000
};

const POD = {
  present: true, readable: true, carrier: 'UPS', trackingNumber: '1Z999AA10123456784',
  delivered: true, deliveredOn: '2026-09-22', consigneeName: 'Halcyon Retail Group',
  deliveryAddress: { line1: '4400 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
  hasSignature: true, hasPhoto: false, poRef: 'PO-88421',
  confidence: { trackingNumber: 0.97, consigneeName: 0.95, deliveredOn: 0.93, deliveryAddress: 0.91 }
};

function book() {
  return openDb(':memory:');
}

function intake(db: any, invoiceNumber: string, docText: string, podOverrides: Record<string, any> = {}) {
  const input: CreateInvoiceInput = {
    seller: SELLER, debtor: DEBTOR,
    invoice: {
      invoiceNumber, totalCents: 4_800_000, issuedOn: '2026-09-24', dueOn: '2026-11-23', poRef: 'PO-88421',
      lineItems: [{ description: 'goods', cents: 4_800_000 }]
    },
    pod: { ...POD, ...podOverrides },
    evidenceSha256: sha(docText),
    evidenceText: docText,
    protection: { status: 'ELIGIBLE', trackerId: podOverrides.trackingNumber ?? POD.trackingNumber },
    history: {
      invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
      limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
    },
    sandbox: false, allowProtectionOverride: false
  };
  return intakeInvoice(db, input);
}

const doc = (tracking: string) => `UPS PROOF OF DELIVERY\nTracking number: ${tracking}\nStatus: DELIVERED\nConsignee: Halcyon Retail Group`;

function e06(db: any, invoiceNumber: string) {
  return db.prepare(`SELECT c.detail FROM checks c JOIN invoices i ON i.id = c.invoice_id
                     WHERE i.invoice_number = ? AND c.check_id = 'E06'`).get(invoiceNumber) as any;
}

test('the first upload of a document prices', () => {
  const db = book();
  const first = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  assert.equal(first.status, 'priced');
  assert.equal(first.gate.verdict, 'VERIFIED');
});

test('re-uploading bytes already on the books is refused, not a crash', () => {
  const db = book();
  // The UNIQUE sha256 column would have thrown here once; the refusal has to arrive before the
  // insert, because a seller retrying a duplicate is ordinary traffic, not a server fault.
  const first = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  assert.equal(first.status, 'priced');
  const again = intake(db, 'A-1099', doc('1Z999AA10123456784'));
  assert.equal(again.status, 'REFUSED');
  assert.deepEqual(again.gate.refusals.map((r) => r.code), ['EVIDENCE_REUSED']);
  assert.match(e06(db, 'A-1099').detail, /A-1042/);
  assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM evidence_files').get() as any).n), 1);
});

test('a new file describing a parcel already financed is refused', () => {
  const db = book();
  const first = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  assert.equal(first.status, 'priced');
  // Same shipment, different piece of paper: reprint the label under a new invoice number and the
  // hash is fresh. The tracker is what the two documents have in common.
  const forged = intake(db, 'A-1043', doc('1z-999-aa1-0123-4567-84'), { trackingNumber: '1z-999-aa1-0123-4567-84' });
  assert.equal(forged.status, 'REFUSED');
  assert.deepEqual(forged.gate.refusals.map((r) => r.code), ['TRACKER_REUSED']);
  assert.match(e06(db, 'A-1043').detail, /A-1042/);
});

test('a different parcel from the same debtor still prices', () => {
  const db = book();
  assert.equal(intake(db, 'A-1042', doc('1Z999AA10123456784')).status, 'priced');
  const next = intake(db, 'A-1044', doc('1Z999AA10123456785'), { trackingNumber: '1Z999AA10123456785' });
  assert.equal(next.status, 'priced');
  assert.match(e06(db, 'A-1044').detail, /1Z999AA10123456785/);
});

test('a document with no readable tracker is checked by hash alone', () => {
  const db = book();
  // An envelope whose number the extractor could not read has nothing to compare, so E06 must say
  // so rather than claim two things were proven.
  const noTracker = intake(db, 'A-1045', 'Invoice A-1045. No delivery documentation attached.',
    { present: false, readable: false, trackingNumber: undefined });
  assert.equal(noTracker.status, 'REFUSED');
  assert.deepEqual(noTracker.gate.refusals.map((r) => r.code), ['POD_MISSING']);
  assert.match(e06(db, 'A-1045').detail, /no readable tracking number/i);
});
