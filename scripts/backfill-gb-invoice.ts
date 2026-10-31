import crypto from 'node:crypto';
import { openDb } from '../src/db.ts';
import { intakeInvoice } from '../src/store.ts';
import { config, isSandbox } from '../src/config.ts';

// Dev-time backfill: the seeded GB fixture was added to src/seed.ts after this workspace's database
// already held live PayPal history, so the row is intake'd once rather than by resetting the book.
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const gbDoc = [
  'ROYAL MAIL PROOF OF DELIVERY',
  'Tracking number: RB123456789GB',
  'Status: DELIVERED',
  'Delivered on: 2026-10-05 at 14:32',
  'Consignee: Meridian Trading Limited',
  'Ship to: 12 Old Street, London EC1R 1PG',
  'Customer PO: PO-551',
  'Signed by: R. OKAFOR',
  'Signature captured on device.',
  'Reference: INV MT-2207'
].join('\n');

const billing = { line1: '12 Old Street', city: 'London', postalCode: 'EC1R 1PG', countryCode: 'GB' };
const db = openDb();

if (db.prepare("SELECT 1 x FROM invoices WHERE invoice_number = 'MT-2207'").get()) {
  console.log('MT-2207 already on this book; nothing written.');
} else {
  const out = intakeInvoice(db, {
    seller: { id: 'seller-northwind', name: 'Northwind Components LLC', country: 'US', paypalMerchantId: config.sellerEmail || undefined },
    debtor: { id: 'debtor-meridian-gb', name: 'Meridian Trading Ltd', aliases: ['Meridian Trading'], billingAddress: billing, limitCents: 8_000_000 },
    invoice: {
      invoiceNumber: 'MT-2207', totalCents: 240_000, issuedOn: '2026-10-15', dueOn: '2026-12-14', poRef: 'PO-551',
      lineItems: [
        { description: 'Precision bracket, machined', cents: 140_000 },
        { description: 'Freight and handling', cents: 100_000 }
      ]
    },
    pod: {
      present: true, readable: true, carrier: 'Royal Mail', trackingNumber: 'RB123456789GB',
      delivered: true, deliveredOn: '2026-10-05', consigneeName: 'Meridian Trading Limited',
      deliveryAddress: billing, hasSignature: true, hasPhoto: false, poRef: 'PO-551',
      confidence: { trackingNumber: 0.95, consigneeName: 0.95, deliveredOn: 0.93, deliveryAddress: 0.91 }
    },
    evidenceSha256: sha(gbDoc),
    evidenceText: gbDoc,
    protection: { status: 'UNKNOWN', trackerId: 'RB123456789GB' },
    history: {
      invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000, limitCents: 8_000_000,
      monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 240_000
    },
    sandbox: isSandbox(),
    allowProtectionOverride: true
  });
  console.log('MT-2207', out.status, out.gate.verdict, out.gate.jurisdiction?.label, out.price?.advanceCents, out.invoiceId);
}
console.log('sha256', sha(gbDoc));
