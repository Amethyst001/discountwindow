import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, nowIso } from '../src/db.ts';
import { sweepOverdue, declareDefault, collectRepurchase, writeOffClaim } from '../src/store.ts';
import { accountBalance, unbalancedTransactions, postFunding } from '../src/ledger.ts';
import { priceSlice } from '../src/price.ts';

const TODAY = '2026-11-10';

function fixture(opts: { recourse?: 'recourse' | 'non_recourse'; country?: string; dueOn?: string } = {}) {
  const db = openDb(':memory:');
  const at = nowIso();
  db.prepare("INSERT INTO sellers (id, paypal_merchant_id, legal_name, country, created_at) VALUES ('s1','seller@example.com','Northwind','US',?)").run(at);
  db.prepare('INSERT INTO debtors (id, legal_name, normalized_name, billing_address_json, limit_cents, created_at) VALUES (?,?,?,?,?,?)')
    .run('d1', 'Halcyon', 'halcyon', JSON.stringify({ countryCode: opts.country ?? 'US' }), 1_000_000, at);
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Sandbox Funder','funder@example.com',?)").run(at);
  db.prepare(`INSERT INTO invoices (id, invoice_number, seller_id, debtor_id, face_cents, currency, issued_on, due_on, status, created_at)
              VALUES ('inv_1','NW-1','s1','d1',65000,'USD','2026-10-01',?,'funded',?)`).run(opts.dueOn ?? '2026-11-01', at);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl_1','inv_1','f1',10000,49301,'paid',?)").run(at);
  db.prepare(`INSERT INTO prices (id, invoice_id, annual_rate_bp, tenor_days, fee_reserve_cents, discount_cents,
                                   advance_cents, platform_fee_cents, recourse, created_at)
              VALUES ('pr_1','inv_1',1400,60,1172,3627,49301,325,?,?)`).run(opts.recourse ?? 'recourse', at);
  // The advance has to be on the book before any of this means anything: every assertion below is
  // about where the funder's outlay goes, and it only exists because funding posted it.
  postFunding(db, 'inv_1', 'f1', 's1', { advanceCents: 49301, platformFeeCents: 325 });
  return db;
}

test('the grace period comes from the debtor country, not from code', () => {
  // Six days past the due date: past the five the United States profile allows, inside the seven the
  // United Kingdom profile allows. Same invoice, same dates, different billing country.
  assert.deepEqual(sweepOverdue(fixture({ dueOn: '2026-11-04', country: 'US' }), TODAY).map((r) => r.invoiceId), ['inv_1']);
  assert.deepEqual(sweepOverdue(fixture({ dueOn: '2026-11-04', country: 'GB' }), TODAY), []);
  assert.deepEqual(sweepOverdue(fixture({ dueOn: '2026-11-02', country: 'GB' }), TODAY).map((r) => r.graceDays), [7]);
});

test('a default is declared only on paper already called overdue', () => {
  const db = fixture();
  assert.throws(() => declareDefault(db, 'inv_1', TODAY), /only an overdue invoice/);
  sweepOverdue(db, TODAY);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'overdue');
});

test('recourse paper becomes a claim, and the ledger refuses to book the promise', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  const out = declareDefault(db, 'inv_1', TODAY);
  assert.deepEqual(out, { mode: 'recourse', funderOutlayCents: 49301, claimCents: 49301, status: 'claim_open', daysPastDue: 9 });
  // Nothing recovered yet, so nothing moved: the funder's outlay is still an asset on the book.
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 49301);
  assert.equal(accountBalance(db, 'platform:clearing'), 0);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'defaulted');
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('non-recourse paper is written off the day it defaults, because that was the trade', () => {
  const db = fixture({ recourse: 'non_recourse' });
  sweepOverdue(db, TODAY);
  const out = declareDefault(db, 'inv_1', TODAY);
  assert.equal(out.status, 'written_off');
  assert.equal(out.claimCents, 0);
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 0, 'the outlay is off the book');
  assert.equal(accountBalance(db, 'funder:f1:yield'), 49301, 'and lands as a loss against the funder position');
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('the seller repurchasing returns the funder from the seller, not from the debtor', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  const paid = collectRepurchase(db, 'inv_1', 49301);
  assert.deepEqual(paid, { amountCents: 49301, shortfallCents: 0, status: 'repurchased' });
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 0);
  assert.equal(accountBalance(db, 'platform:clearing'), 49301);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'repurchased');
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('a partial repurchase leaves the rest as a claim instead of calling it recovered', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  const paid = collectRepurchase(db, 'inv_1', 20000);
  assert.equal(paid.status, 'claim_open');
  assert.equal(paid.shortfallCents, 29301);
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 29301);
  assert.equal((db.prepare('SELECT claim_cents FROM default_events WHERE invoice_id = ?').get('inv_1') as any).claim_cents, 29301);
});

test('a claim that goes bad is written off once, and only a claim can go bad that way', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  assert.deepEqual(writeOffClaim(db, 'inv_1'), { amountCents: 49301 });
  assert.equal((db.prepare('SELECT status FROM default_events WHERE invoice_id = ?').get('inv_1') as any).status, 'uncollectible');
  assert.throws(() => writeOffClaim(db, 'inv_1'), /already uncollectible/);
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 0);
});

test('a written-off non-recourse position has no claim to collect', () => {
  const db = fixture({ recourse: 'non_recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  assert.throws(() => collectRepurchase(db, 'inv_1', 1000), /no claim to collect/);
  assert.throws(() => declareDefault(db, 'inv_1', TODAY), /only an overdue invoice/);
});

test('band C paper cannot be bought without recourse at any rate', () => {
  const asked = priceSlice({ faceCents: 65_000, shareBp: 6000, tenorDays: 60, band: 'C', recourse: 'non_recourse' });
  assert.equal(asked.ok, false);
  assert.match(asked.reason ?? '', /with recourse to the seller/);
  const given = priceSlice({ faceCents: 65_000, shareBp: 6000, tenorDays: 60, band: 'C' });
  assert.equal(given.ok, true);
  assert.equal(given.recourse, 'recourse');
});

test('relief from recourse is priced, not given away', () => {
  const recourse = priceSlice({ faceCents: 65_000, shareBp: 8000, tenorDays: 60, band: 'B' });
  const nonRecourse = priceSlice({ faceCents: 65_000, shareBp: 8000, tenorDays: 60, band: 'B', recourse: 'non_recourse' });
  assert.equal(nonRecourse.annualRateBp, recourse.annualRateBp + 400);
  assert.ok(Number(nonRecourse.advanceCents) < Number(recourse.advanceCents), 'the desk advances less when it keeps the risk');
});

test('two partial repurchases add up to the claim instead of overlapping', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  assert.equal(collectRepurchase(db, 'inv_1', 20000).shortfallCents, 29301);
  const settled = collectRepurchase(db, 'inv_1', 29301);
  assert.deepEqual({ status: settled.status, shortfall: settled.shortfallCents }, { status: 'repurchased', shortfall: 0 });
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 0);
  assert.equal((db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status, 'repurchased');
  // The claim is closed, so a third payment has nothing to be applied to — it is not a repurchase
  // and the book will not let it look like one.
  assert.throws(() => collectRepurchase(db, 'inv_1', 1), /already repurchased/);
});

test('a claim abandoned after a partial payment is written off for the remainder only', () => {
  const db = fixture({ recourse: 'recourse' });
  sweepOverdue(db, TODAY);
  declareDefault(db, 'inv_1', TODAY);
  collectRepurchase(db, 'inv_1', 30000);
  assert.deepEqual(writeOffClaim(db, 'inv_1'), { amountCents: 19301 });
  assert.equal(accountBalance(db, 'funder:f1:outlay'), 0);
  // The funder's loss is what never came back, not the whole advance written off a second time.
  // A revenue account on the debit side is a loss: +19301 means the yield line was debited, and only
  // by the unpaid remainder.
  assert.equal(accountBalance(db, 'funder:f1:yield'), 19301);
});
