import crypto from 'node:crypto';
import fs from 'node:fs';
import { openDb, nowIso } from './db.ts';
import { intakeInvoice, ensureParty, type CreateInvoiceInput } from './store.ts';
import { config, isSandbox } from './config.ts';
import type { DebtorHistory } from './score.ts';

// A reset replaces the database file. The ledger is append-only in the schema itself, so rows
// cannot be deleted; a fresh file is the only honest way to start over.
if (process.argv.includes('--reset') && config.dbPath !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  console.log(`removed ${config.dbPath}`);
}

const db = openDb();

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261030);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const SELLER = { id: 'seller-northwind', name: 'Northwind Components LLC', country: 'US', paypalMerchantId: config.sellerEmail || undefined };

const DEMO_DEBTOR = {
  id: 'debtor-halcyon',
  name: 'Halcyon Retail Group',
  aliases: ['Halcyon Retail', 'Halcyon Group'],
  billingAddress: { line1: '4400 Congress Avenue', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
  limitCents: 30_000_000
};

const DEMO_HISTORY: DebtorHistory = {
  invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
  limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
};

const GOOD_POD = {
  present: true, readable: true, carrier: 'FedEx', trackingNumber: '770123456789',
  delivered: true, deliveredOn: '2026-09-22',
  consigneeName: 'Halcyon Retail Group',
  deliveryAddress: { line1: '4400 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
  hasSignature: true, hasPhoto: false, poRef: 'PO-88421',
  confidence: { trackingNumber: 0.97, consigneeName: 0.95, deliveredOn: 0.93, deliveryAddress: 0.91 }
};

function podDoc(opts: { consignee: string; address: string; tracking: string; carrier: string; deliveredOn: string; signature: boolean; poRef: string; invoice?: string }) {
  return [
    `${opts.carrier.toUpperCase()} PROOF OF DELIVERY`,
    `Tracking number: ${opts.tracking}`,
    `Status: DELIVERED`,
    `Delivered on: ${opts.deliveredOn} at 14:32`,
    `Consignee: ${opts.consignee}`,
    `Ship to: ${opts.address}`,
    `Customer PO: ${opts.poRef}`,
    `Signed by: ${opts.signature ? 'R. OKAFOR' : 'n/a'}`,
    `${opts.signature ? 'Signature captured on device.' : 'No signature captured.'}`,
    `Reference: INV ${opts.invoice ?? 'A-1042'}`
  ].join('\n');
}

const INVOICE_A = {
  invoiceNumber: 'A-1042', totalCents: 4_800_000, issuedOn: '2026-09-24', dueOn: '2026-11-23', poRef: 'PO-88421',
  lineItems: [
    { description: 'Aluminium extrusion, 6061-T6, 12ft', cents: 1_800_000 },
    { description: 'Precision bracket, machined', cents: 2_100_000 },
    { description: 'Freight and handling', cents: 900_000 }
  ]
};

function intake(input: CreateInvoiceInput) {
  return intakeInvoice(db, { ...input, sandbox: isSandbox(), allowProtectionOverride: true });
}

// ---- 1. A clean invoice that verifies, prices, and matches the pinned worked example.
const goodDoc = podDoc({
  consignee: 'Halcyon Retail Group', address: '4400 Congress Ave, Austin TX 78701',
  tracking: '770123456789', carrier: 'FedEx', deliveredOn: '2026-09-22', signature: true, poRef: 'PO-88421'
});
const a = intake({
  seller: SELLER, debtor: DEMO_DEBTOR, invoice: INVOICE_A, pod: GOOD_POD,
  evidenceSha256: sha(goodDoc), evidenceText: goodDoc,
  // The sandbox never returns ELIGIBLE (measured: UNKNOWN / NOT_ELIGIBLE), so no fixture claims it.
  protection: { status: 'UNKNOWN', trackerId: '770123456789' }, history: DEMO_HISTORY
});
console.log('A-1042', a.status, a.gate.verdict, 'score', a.score.score, a.score.band, a.price ? `advance ${a.price.advanceCents}` : '');

ensureParty(db, 'funders', { id: 'funder-firstlight', name: 'Firstlight Credit Partners', paypalEmail: config.funderEmail || 'funder@example.com' });
db.prepare(`INSERT OR REPLACE INTO debtor_history (debtor_id, invoices_due, paid_on_time, days_late_average, months_active, disputes)
            VALUES (?,?,?,?,?,?)`).run(DEMO_DEBTOR.id, 24, 16, 4.2, 18, 0);

// ---- 1b. The same seller, a smaller receivable. This is the one the demo funds against the live
// sandbox. Sandbox payee accounts created through Adaptive Accounts are unverified and refuse
// payments above roughly $500 (measured: a $1,821.12 capture to the same payees failed while
// $450 and $1 succeeded), so the live invoice sits inside that ceiling.
const liveDoc = podDoc({
  consignee: 'Halcyon Retail Group',
  invoice: 'NW-2277',
  address: '4400 Congress Ave, Austin TX 78701',
  tracking: '770123456812', carrier: 'FedEx', deliveredOn: '2026-10-02', signature: true, poRef: 'PO-88513'
});
const live = intake({
  seller: SELLER, debtor: DEMO_DEBTOR,
  invoice: {
    invoiceNumber: 'NW-2277', totalCents: 65_000, issuedOn: '2026-10-06', dueOn: '2026-12-05', poRef: 'PO-88513',
    lineItems: [
      { description: 'Aluminium extrusion, 6061-T6, 12ft', cents: 24_000 },
      { description: 'Precision bracket, machined', cents: 28_000 },
      { description: 'Freight and handling', cents: 13_000 }
    ]
  },
  pod: { ...GOOD_POD, trackingNumber: '770123456812', deliveredOn: '2026-10-02', poRef: 'PO-88513' },
  evidenceSha256: sha(liveDoc), evidenceText: liveDoc,
  protection: { status: 'UNKNOWN', trackerId: '770123456812' }, history: { ...DEMO_HISTORY, faceCents: 65_000 }
});
console.log('NW-2277', live.status, live.gate.verdict, live.price ? `advance ${live.price.advanceCents}` : '');

// ---- 1c. The second jurisdiction profile, decided by the same eleven checks. The debtor bills from
// London, so the gate loads rules/jurisdictions.yaml#GB: it believes Royal Mail, requires a postcode
// rather than a ZIP, allows a 60-day-old delivery and a 120-day tenor. Nothing in the money code
// changed, and the invoice below would be refused TRACKING_INVALID and ADDRESS_MISMATCH under the US
// profile with the same document (tests/jurisdiction.test.ts asserts exactly that pair).
const GB_DEBTOR = {
  id: 'debtor-meridian-gb',
  name: 'Meridian Trading Ltd',
  aliases: ['Meridian Trading'],
  billingAddress: { line1: '12 Old Street', city: 'London', postalCode: 'EC1R 1PG', countryCode: 'GB' },
  limitCents: 8_000_000
};
const gbDoc = podDoc({
  consignee: 'Meridian Trading Limited', invoice: 'MT-2207',
  address: '12 Old Street, London EC1R 1PG',
  tracking: 'RB123456789GB', carrier: 'Royal Mail', deliveredOn: '2026-10-05', signature: true, poRef: 'PO-551'
});
const gb = intake({
  seller: SELLER, debtor: GB_DEBTOR,
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
    deliveryAddress: GB_DEBTOR.billingAddress, hasSignature: true, hasPhoto: false, poRef: 'PO-551',
    confidence: { trackingNumber: 0.95, consigneeName: 0.95, deliveredOn: 0.93, deliveryAddress: 0.91 }
  },
  evidenceSha256: sha(gbDoc), evidenceText: gbDoc,
  protection: { status: 'UNKNOWN', trackerId: 'RB123456789GB' },
  history: { ...DEMO_HISTORY, faceCents: 240_000 }
});
console.log('MT-2207', gb.status, gb.gate.verdict, gb.gate.jurisdiction?.label, gb.price ? `advance ${gb.price.advanceCents}` : '');
// ---- 2. The refusal the demo opens on: delivered to the wrong entity.
const badDoc = podDoc({
  consignee: 'Halcyon Logistics', invoice: 'A-1043', address: '4400 Congress Ave, Austin TX 78701',
  tracking: '770123456790', carrier: 'FedEx', deliveredOn: '2026-09-22', signature: true, poRef: 'PO-88421'
});
const b = intake({
  seller: SELLER, debtor: DEMO_DEBTOR,
  invoice: { ...INVOICE_A, invoiceNumber: 'A-1043' },
  pod: { ...GOOD_POD, trackingNumber: '770123456790', consigneeName: 'Halcyon Logistics' },
  evidenceSha256: sha(badDoc), evidenceText: badDoc,
  protection: { status: 'UNKNOWN', trackerId: '770123456790' }, history: DEMO_HISTORY
});
console.log('A-1043', b.status, b.gate.verdict, b.gate.refusals.map((r) => r.code).join(','));

// ---- 3. No proof of delivery at all.
const noPodText = 'Invoice B-2201. No delivery documentation attached.';
const noPod = intake({
  seller: SELLER, debtor: { ...DEMO_DEBTOR, id: 'debtor-bramble', name: 'Bramble & Co' },
  invoice: { ...INVOICE_A, invoiceNumber: 'B-2201', totalCents: 1_250_000, lineItems: [{ description: 'Goods', cents: 1_250_000 }] },
  pod: { present: false, readable: false },
  evidenceSha256: sha(noPodText), evidenceText: noPodText,
  protection: { status: 'UNKNOWN' }, history: { ...DEMO_HISTORY, faceCents: 1_250_000 }
});
console.log('B-2201', noPod.status, noPod.gate.refusals.map((r) => r.code).join(','));

// ---- 4. The synthetic book. Deterministic, and the archive counts come from it.
const DEBTORS = [
  'Meridian Supply Co', 'Oakline Foods', 'Cobalt Textiles', 'Ridgeline Hardware', 'Pinewood Paper',
  'Ardent Chemicals', 'Beacon Fasteners', 'Juniper Packaging', 'Kestrel Motors', 'Larkspur Interiors',
  'Marlowe Plastics', 'Nettle & Sons', 'Orchard Electronics', 'Pallas Coatings', 'Quarry Stone Works',
  'Redfern Tools', 'Sable Optics', 'Tamarack Timber', 'Upland Ceramics', 'Verdant Nurseries'
];
const CITIES = [
  ['Austin','TX','78701'], ['Denver','CO','80202'], ['Portland','OR','97204'], ['Columbus','OH','43215'],
  ['Raleigh','NC','27601'], ['Boise','ID','83702'], ['Tulsa','OK','74103'], ['Omaha','NE','68102']
];
const STREETS = ['100 Congress Ave', '2200 Blake St', '505 SW Salmon St', '88 E Broad St', '410 Fayetteville St', '77 N 8th St'];

// Each entry is a reason the archive shows, so the split is also what proves a code is reachable in
// data and not only in a test: E03 has two refusal codes, and a fixture that sets delivered=false
// exercises only one of them.
const REASONS = [
  ['POD_MISSING', 210], ['ADDRESS_MISMATCH', 148], ['CONSIGNEE_MISMATCH', 96],
  ['TRACKING_INVALID', 74], ['DELIVERY_DATE_OUT_OF_WINDOW', 26], ['NOT_DELIVERED', 26],
  ['NO_SIGNATURE_EVIDENCE', 38]
] as const;

const total = 1000;
const refusedCount = REASONS.reduce((a, [, n]) => a + n, 0);
const verifiedCount = total - refusedCount;

const refusals: string[] = [];
for (const [code, n] of REASONS) for (let i = 0; i < n; i++) refusals.push(code);
for (let i = refusals.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [refusals[i], refusals[j]] = [refusals[j], refusals[i]];
}

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(rand() * arr.length)]; }

db.exec('BEGIN');
try {
  for (let i = 0; i < total; i++) {
    const code = i < refusedCount ? refusals[i] : null;
    const debtorName = pick(DEBTORS);
    const [city, state, zip] = pick(CITIES);
    const line1 = pick(STREETS);
    const face = (250 + Math.floor(rand() * 4750)) * 100; // $250 .. $5,000
    // A receivable is always issued before today; the delivery precedes the invoice. Deriving
    // `due` from `issued` (not the other way round) keeps future dates out of the book.
    const issued = new Date(Date.now() - (1 + Math.floor(rand() * 25)) * 86_400_000);
    const due = new Date(issued.getTime() + (30 + Math.floor(rand() * 60)) * 86_400_000);
    const deliveredOn = new Date(issued.getTime() - (2 + Math.floor(rand() * 20)) * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const debtorId = `debtor-${debtorName.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    const invoiceNumber = `${debtorName.slice(0, 1)}-${3000 + i}`;
    const tracking = `1Z${String(1000000000000000 + i).slice(0, 16)}`;

    const pod: any = {
      present: code !== 'POD_MISSING',
      readable: code !== 'POD_MISSING',
      carrier: 'UPS',
      trackingNumber: code === 'TRACKING_INVALID' ? 'X' : tracking,
      delivered: code !== 'NOT_DELIVERED',
      deliveredOn: code === 'DELIVERY_DATE_OUT_OF_WINDOW' ? iso(new Date(issued.getTime() - 140 * 86_400_000)) : iso(deliveredOn),
      consigneeName: code === 'CONSIGNEE_MISMATCH' ? pick(DEBTORS.filter((n) => n !== debtorName)) : debtorName,
      deliveryAddress: code === 'ADDRESS_MISMATCH'
        ? { line1: '999 Unknown Rd', city, state, postalCode: zip, countryCode: 'US' }
        : { line1, city, state, postalCode: zip, countryCode: 'US' },
      hasSignature: code !== 'NO_SIGNATURE_EVIDENCE',
      hasPhoto: false,
      poRef: 'PO-1',
      confidence: { trackingNumber: 0.96, consigneeName: 0.94, deliveredOn: 0.92, deliveryAddress: 0.9 }
    };

    const history: DebtorHistory = {
      invoicesDue: 6 + Math.floor(rand() * 30),
      paidOnTime: 0,
      daysLateAverage: rand() * 12,
      outstandingCents: Math.floor(rand() * 20_000_000),
      limitCents: 25_000_000 + Math.floor(rand() * 25_000_000),
      monthsActive: 3 + Math.floor(rand() * 40),
      disputes: Math.floor(rand() * 3),
      totalInvoices: 8 + Math.floor(rand() * 40),
      faceCents: face
    };
    history.paidOnTime = Math.round(history.invoicesDue * (0.55 + rand() * 0.45));

    // The document carries its own invoice number, so the stored hash is the hash of the text a
    // reviewer can read on the page — not a salted stand-in.
    const text = pod.present
      ? podDoc({ consignee: pod.consigneeName, invoice: invoiceNumber, address: `${pod.deliveryAddress.line1}, ${city} ${zip}`, tracking: pod.trackingNumber, carrier: 'UPS', deliveredOn: pod.deliveredOn, signature: pod.hasSignature, poRef: 'PO-1' })
      : `Invoice ${invoiceNumber}. No delivery documentation attached.`;

    const made = intake({
      seller: SELLER,
      debtor: { id: debtorId, name: debtorName, billingAddress: { line1, city, state, postalCode: zip, countryCode: 'US' }, limitCents: history.limitCents },
      invoice: { invoiceNumber, totalCents: face, issuedOn: iso(issued), dueOn: iso(due), poRef: 'PO-1', lineItems: [{ description: 'Goods', cents: face }] },
      pod,
      evidenceSha256: sha(text),
      evidenceText: text,
      // No PayPal sale exists behind a generated invoice, so there is no protection record to read.
      // UNKNOWN is the sandbox's honest answer and E00 records the override; claiming ELIGIBLE for a
      // transaction that never ran through the rail would fabricate PayPal's own evidence.
      protection: { status: 'UNKNOWN', trackerId: tracking },
      history
    });
    if (made.status === 'priced') db.prepare("UPDATE invoices SET status = 'listed' WHERE id = ?").run(made.invoiceId);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log(`seeded ${total} synthetic invoices; refused ${refusedCount}, verified ${verifiedCount}`);
console.log(`database: ${config.dbPath}`);
