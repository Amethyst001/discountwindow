import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.ts';
import { intakeInvoice, invoiceDetail, type CreateInvoiceInput } from '../src/store.ts';
import { issueAssignmentNotice } from '../src/notice.ts';
import { renderDealRoom, renderBook, renderStatus, readerDisagreementMarks } from '../src/pages.ts';
import { formatCents } from '../src/money.ts';
import { extractDeterministic, reconcile, reconcilePixels, type Extraction } from '../src/extract.ts';

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

const doc = (tracking: string) => `UPS PROOF OF DELIVERY\nTracking number: ${tracking}\nStatus: DELIVERED\nConsignee: Halcyon Retail Group`;

function intake(
  db: any, invoiceNumber: string, docText: string, podOverrides: Record<string, any> = {},
  evidence?: CreateInvoiceInput['evidence'], pod?: CreateInvoiceInput['pod']
) {
  const input: CreateInvoiceInput = {
    seller: SELLER, debtor: DEBTOR,
    invoice: {
      invoiceNumber, totalCents: 4_800_000, issuedOn: '2026-09-24', dueOn: '2026-11-23', poRef: 'PO-88421',
      lineItems: [{ description: 'goods', cents: 4_800_000 }]
    },
    pod: pod ?? { ...POD, ...podOverrides },
    evidenceSha256: sha(docText),
    evidenceText: docText,
    protection: { status: 'ELIGIBLE', trackerId: podOverrides.trackingNumber ?? POD.trackingNumber },
    evidence,
    history: {
      invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
      limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
    },
    sandbox: false, allowProtectionOverride: false
  };
  return intakeInvoice(db, input);
}

function desk(db: any, id: string) {
  return renderDealRoom(invoiceDetail(db, id), true, 'desk', { role: 'desk', name: 'desk' });
}

test('the deal room renders a priced invoice from stored rows', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  const html = desk(db, made.invoiceId);
  assert.match(html, /A-1042/);
  assert.match(html, /The eleven checks/);
  assert.match(html, /both unique to this invoice/);
  assert.match(html, /Notice of assignment/);
  assert.match(html, /Not issued/);
  assert.doesNotMatch(html, /Service register/);
});

test('the service register is the desk\'s own page, and only appears once a notice exists', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Firstlight','funder@example.com',?)")
    .run(new Date().toISOString());
  db.prepare("UPDATE invoices SET status = 'funded' WHERE id = ?").run(made.invoiceId);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl1',?,'f1',10000,3642801,'paid',?)")
    .run(made.invoiceId, new Date().toISOString());
  const notice = issueAssignmentNotice(db, made.invoiceId)!;
  const html = desk(db, made.invoiceId);
  assert.match(html, /Service register/);
  assert.match(html, /Nothing recorded yet/);
  assert.match(html, new RegExp(notice.sha256.slice(0, 32)));
  // The whole book's register is a desk artefact, so the way into it sits on the desk's card only.
  assert.match(html, /href="\/notices\/register\.csv"/);
  // A different side of the trade does not get the desk's notebook, and cannot write in it.
  for (const view of ['seller', 'funder', 'debtor'] as const) {
    const other = renderDealRoom(invoiceDetail(db, made.invoiceId), true, view, { role: view, name: view });
    assert.doesNotMatch(other, /Service register/, view);
    assert.doesNotMatch(other, /register\.csv/, view);
  }
});

test('a document refused for a collision says what it collided with, in place of the bytes', () => {
  const db = openDb(':memory:');
  intake(db, 'A-1042', doc('1Z999AA10123456784'));
  const again = intake(db, 'A-1099', doc('1Z999AA10123456784'));
  const html = desk(db, again.invoiceId);
  assert.match(html, /Refused/);
  assert.match(html, /EVIDENCE_REUSED/);
  assert.match(html, /already filed against invoice A-1042/);
});

test('what the two readers could not agree on is marked in the document itself', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  db.prepare(`UPDATE extractions SET fields_json = JSON_SET(fields_json, '$.notes',
    JSON('["consigneeName: readers disagree (model \\"Halcyon Retail\\", parser \\"Halcyon Retail Group\\")"]'))
    WHERE evidence_id = (SELECT id FROM evidence_files WHERE invoice_id = ?)`).run(made.invoiceId);
  const html = desk(db, made.invoiceId);
  assert.match(html, /<mark>Halcyon Retail<\/mark>/);
  assert.match(html, /what the two readers could not agree on/);
});

test('the disagreement marks come only from notes that name a disagreement', () => {
  assert.deepEqual(
    readerDisagreementMarks(['trackingNumber: readers disagree (model "1Z999AA10123456784", parser "1Z999AA10123456785")']),
    ['1Z999AA10123456784', '1Z999AA10123456785']
  );
  assert.deepEqual(readerDisagreementMarks(['deliveredOn: found by the label parser only (no value from the model)']), []);
  assert.deepEqual(readerDisagreementMarks(undefined), []);
  assert.deepEqual(
    readerDisagreementMarks(['poRef: readers disagree (model "null", parser "")']),
    [],
    'an absent value is not a thing to mark'
  );
});

const FULL_POD = `UPS PROOF OF DELIVERY
Tracking number: 1Z999AA10123456784
Status: DELIVERED
Consignee: Halcyon Retail Group
Delivered: 2026-09-22`;

/** A model reading that agrees with the parser everywhere except the consignee's name. */
function twoReaderRead(parserAnswer: ReturnType<typeof extractDeterministic>): Extraction {
  return {
    model: 'gpt-test', modelVersion: '2026-09', text: FULL_POD,
    pod: { ...parserAnswer.pod, consigneeName: 'Halcyon Retail' },
    invoiceHints: parserAnswer.invoiceHints,
    confidence: { ...parserAnswer.confidence, consigneeName: 0.9 },
    notes: [], raw: {}
  };
}

test('the deal room shows both readings side by side and shades the field they split on', () => {
  const db = openDb(':memory:');
  const parserAnswer = extractDeterministic(FULL_POD);
  const merged = reconcile(twoReaderRead(parserAnswer), parserAnswer, FULL_POD);
  const made = intake(db, 'A-1042', FULL_POD, {}, {
    model: merged.model, modelVersion: merged.modelVersion, raw: merged.raw,
    confidence: merged.confidence, notes: merged.notes
  }, merged.pod);
  const html = desk(db, made.invoiceId);
  assert.match(html, /<th>Model read<\/th><th>Parser read<\/th><th>Used<\/th>/);
  const diffRows = html.match(/<tr class="diff">/g) ?? [];
  assert.equal(diffRows.length, 1, 'only the field the readers split on is shaded');
  assert.match(html, /<tr class="diff">[\s\S]*?Consignee[\s\S]*?Halcyon Retail<\/td>[\s\S]*?Halcyon Retail Group<\/td>[\s\S]*?45%[\s\S]*?<\/tr>/);
  // Halved confidence is what the disagreement costs, and it is below the floor: the same row that
  // is shaded on the page is the reason the invoice is not priced.
  assert.match(html, /POD_UNREADABLE/);
  assert.match(html, /a field read below the floor can fail a check but cannot satisfy one/);
});

test('a document read by one writer has no comparison to show', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  const html = desk(db, made.invoiceId);
  assert.doesNotMatch(html, /Model read/);
  assert.doesNotMatch(html, /<tr class="diff">/);
  assert.match(html, /The deterministic label parser read the document/);
});

/** A model's own read of the photograph, with the answer it gave kept as the raw row. */
function pixelRead(
  name: string, parserAnswer: ReturnType<typeof extractDeterministic>,
  overrides: Record<string, any> = {}, confidence: Record<string, number> = {}
): Extraction {
  const pod = { ...parserAnswer.pod, ...overrides };
  return {
    model: name, modelVersion: '1', text: FULL_POD,
    pod: { ...pod, confidence },
    invoiceHints: parserAnswer.invoiceHints,
    confidence: { ...parserAnswer.confidence, ...confidence },
    notes: [], raw: { ...pod }
  };
}

test('a photographed document is opened by two models, and the page shows both answers', () => {
  const db = openDb(':memory:');
  const parserAnswer = extractDeterministic(FULL_POD);
  const pixels = reconcilePixels(
    pixelRead('gpt-test', parserAnswer, { consigneeName: 'Halcyon Retail' }, { consigneeName: 0.9 }),
    pixelRead('nvidia/vl-test', parserAnswer)
  );
  const merged = reconcile(pixels, parserAnswer, FULL_POD);
  const made = intake(db, 'A-1051', FULL_POD, {}, {
    model: merged.model, modelVersion: merged.modelVersion, raw: merged.raw,
    confidence: merged.confidence, notes: merged.notes
  }, merged.pod);
  const html = desk(db, made.invoiceId);
  assert.match(html, /<th>gpt-test<\/th><th>nvidia\/vl-test<\/th><th>Parser read<\/th><th>Used<\/th>/);
  // The card says who did the reading, in the same words the page uses for a single reader's picture:
  // two names, not one name plus a version string a reviewer cannot check.
  assert.match(html, /<span class="mono">gpt-test<\/span> and <span class="mono">nvidia\/vl-test<\/span> each read the photograph/);
  const diffRows = html.match(/<tr class="diff">/g) ?? [];
  assert.equal(diffRows.length, 1, 'only the field the readers split on is shaded');
  // Two comparisons disagreed, so the field is halved twice and the second one is what a single model
  // could not have produced: the parser cannot bring it back over the floor.
  assert.match(html, /<tr class="diff">[\s\S]*?Consignee[\s\S]*?Halcyon Retail<\/td>[\s\S]*?Halcyon Retail Group<\/td>[\s\S]*?23%[\s\S]*?<\/tr>/);
  assert.match(html, /POD_UNREADABLE/);
  assert.match(html, /cannot arbitrate a disagreement about the photograph/);
});


test('the view is a lens; the buttons follow the name that signed in', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1052', doc('1Z999AA10123456789'));
  const funderDesk = renderDealRoom(invoiceDetail(db, made.invoiceId), true, 'desk', { role: 'funder', name: 'funder' });
  const sellerDesk = renderDealRoom(invoiceDetail(db, made.invoiceId), true, 'desk', { role: 'seller', name: 'seller' });
  // A funder reading the desk's page is holding the verb that page asks for, so the button is there.
  assert.match(funderDesk, /action="\/invoices\/[a-z0-9_]+\/fund"/);
  // A seller reading the same page gets no button to press and no 403 to discover: it is told who
  // holds the verb, in the same sentence that names the lens it is wearing.
  assert.doesNotMatch(sellerDesk, /action="\/invoices\/[a-z0-9_]+\/fund"/);
  assert.match(sellerDesk, /Fund is pressed by <strong>desk<\/strong> or <strong>funder<\/strong> — not by <strong>seller<\/strong>/);
  assert.match(sellerDesk, /The buttons on this page follow the name you signed in with, not the lens/);
  // And the lens itself opens to everyone: one login, three sides of the trade, no logging out.
  assert.match(sellerDesk, /Signed in as <strong>seller<\/strong> — Seller\. Viewing as/);
  assert.match(sellerDesk, /view=desk"[\s\S]*?view=seller"[\s\S]*?view=funder"/);
});

test('a non-desk name wearing the desk lens still does not get the desk notebook', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1053', doc('1Z999AA10123456790'));
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Firstlight','funder@example.com',?)")
    .run(new Date().toISOString());
  db.prepare("UPDATE invoices SET status = 'funded' WHERE id = ?").run(made.invoiceId);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl1',?,'f1',10000,3642801,'paid',?)")
    .run(made.invoiceId, new Date().toISOString());
  issueAssignmentNotice(db, made.invoiceId);
  const sellerInDeskLens = renderDealRoom(invoiceDetail(db, made.invoiceId), true, 'desk', { role: 'seller', name: 'seller' });
  assert.match(sellerInDeskLens, /Notice of assignment/);
  assert.doesNotMatch(sellerInDeskLens, /Service register/, 'the register is whose log it is, not what lens is worn');
  assert.doesNotMatch(sellerInDeskLens, /register\.csv/);
  assert.doesNotMatch(sellerInDeskLens, /action="\/invoices\/[a-z0-9_]+\/notice\/service"/);
});

test('only the line a failing check read is marked: a consignee refusal does not mark the tracking number', () => {
  const db = openDb(':memory:');
  const text = 'FEDEX PROOF OF DELIVERY\nTracking number: 770123456790\nStatus: DELIVERED\nConsignee: Halcyon Logistics';
  const made = intake(db, 'A-1043', text, { carrier: 'FedEx', trackingNumber: '770123456790', consigneeName: 'Halcyon Logistics' });
  const html = desk(db, made.invoiceId);
  assert.match(html, /Refused: consignee mismatch/);
  assert.match(html, /Consignee: <mark>Halcyon Logistics<\/mark>/);
  assert.doesNotMatch(html, /<mark>[^<]*770123456790/);
});

test('the price reads as a waterfall that adds up: gross less reserve less discount is the advance, less the fee is the seller', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  const detail = invoiceDetail(db, made.invoiceId);
  const p = detail.price;
  const gross = Number(p.advance_cents) + Number(p.discount_cents) + Number(p.fee_reserve_cents);
  const html = desk(db, made.invoiceId);
  assert.match(html, /How the advance is priced/);
  for (const v of [formatCents(gross), `−${formatCents(Number(p.fee_reserve_cents))}`, `−${formatCents(Number(p.discount_cents))}`,
    formatCents(Number(p.advance_cents)), formatCents(Number(p.advance_cents) - Number(p.platform_fee_cents))]) {
    assert.ok(html.includes(v), v);
  }
  assert.match(html, /Seller receives now/);
});

test('a guest sees the fund step as the page\'s main action, switched off, and no form that would post it', () => {
  const db = openDb(':memory:');
  const made = intake(db, 'A-1042', doc('1Z999AA10123456784'));
  const html = renderDealRoom(invoiceDetail(db, made.invoiceId), true, 'funder', { role: 'guest', name: 'guest' });
  assert.match(html, /<button type="button" class="primary" disabled aria-disabled="true">Fund the seller&#39;s advance<\/button>/);
  assert.doesNotMatch(html, /action="\/invoices\/[^"]+\/fund"/);
  const desked = desk(db, made.invoiceId);
  assert.match(desked, /action="\/invoices\/[^"]+\/fund"/);
});

test('the book\'s counts are links to the same filters as the tabs', () => {
  const html = renderBook([], { total: 3, refused: 1, verified: 1, funded: 1 }, true);
  assert.match(html, /href="\/\?filter=refused#book"/);
  assert.match(html, /href="\/\?filter=funded#book"/);
});

test('the status page leads with the chain\'s integrity and says when it is broken', () => {
  const ok = renderStatus({ auditChain: { ok: true, length: 12 }, archiveCounts: { total: 3, refused: 1, verified: 1, funded: 1 } });
  assert.match(ok, /✓ Intact/);
  assert.match(ok, /All 12 hashed entries recompute/);
  const bad = renderStatus({ auditChain: { ok: false, brokenAt: 7, reason: 'hash mismatch' }, archiveCounts: {} });
  assert.match(bad, /✕ Broken/);
  assert.match(bad, /Broken at entry 7: hash mismatch/);
});
