// Reproduce with:  node --disable-warning=ExperimentalWarning scripts/export-default.ts \
//   > evidence/published/x8-default-recourse-chain.json
//
// The default and recourse lifecycle, run against the real store, ledger and audit chain on an
// in-memory book. No PayPal call appears in this file: the money in it was posted by the same
// functions the live funding and maturity captures call, and the artefact is about what happens
// after the debtor does not pay, which is entirely inside the book.
import { openDb, nowIso } from '../src/db.ts';
import { sweepOverdue, declareDefault, collectRepurchase, writeOffClaim } from '../src/store.ts';
import { postFunding, accountBalance, unbalancedTransactions } from '../src/ledger.ts';
import { priceSlice } from '../src/price.ts';
import { jurisdictionFor } from '../src/gate.ts';
import { verifyChain } from '../src/audit.ts';

const TODAY = '2026-11-10';

function book(recourse: 'recourse' | 'non_recourse', country: 'US' | 'GB', dueOn = '2026-11-01') {
  const db = openDb(':memory:');
  const at = nowIso();
  db.prepare("INSERT INTO sellers (id, paypal_merchant_id, legal_name, country, created_at) VALUES ('s1','seller@example.com','Northwind Components LLC',?,?)").run(country, at);
  db.prepare('INSERT INTO debtors (id, legal_name, normalized_name, billing_address_json, limit_cents, created_at) VALUES (?,?,?,?,?,?)')
    .run('d1', 'Halcyon Industries', 'halcyon', JSON.stringify({ countryCode: country }), 1_000_000, at);
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Sandbox Funder','funder@example.com',?)").run(at);
  // Due 2026-11-01, so on 2026-11-10 the paper is nine days past its date: outside the five-day US
  // grace, inside the seven-day GB one. The invoice below is the US book; the GB comparison is
  // reported separately because the same dates decide differently there.
  db.prepare(`INSERT INTO invoices (id, invoice_number, seller_id, debtor_id, face_cents, currency, issued_on, due_on, status, created_at)
              VALUES ('inv_1','NW-1','s1','d1',65000,'USD','2026-10-01',?,'funded',?)`).run(dueOn, at);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl_1','inv_1','f1',10000,49301,'paid',?)").run(at);
  db.prepare(`INSERT INTO prices (id, invoice_id, annual_rate_bp, tenor_days, fee_reserve_cents, discount_cents,
                                   advance_cents, platform_fee_cents, recourse, created_at)
              VALUES ('pr_1','inv_1',1400,60,1172,3627,49301,325,?,?)`).run(recourse, at);
  postFunding(db, 'inv_1', 'f1', 's1', { advanceCents: 49301, platformFeeCents: 325 });
  return db;
}

const status = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT status FROM invoices WHERE id = ?').get('inv_1') as any).status;
const event = (db: ReturnType<typeof openDb>) => db.prepare('SELECT * FROM default_events WHERE invoice_id = ?').get('inv_1') as any;
const balances = (db: ReturnType<typeof openDb>) => ({
  funder_outlay: accountBalance(db, 'funder:f1:outlay'),
  funder_yield: accountBalance(db, 'funder:f1:yield'),
  platform_clearing: accountBalance(db, 'platform:clearing'),
  seller_advance: accountBalance(db, 'seller:s1:advance')
});

// --- recourse: swept, defaulted, repurchased in two parts ------------------------------------
const rec = book('recourse', 'US');
const swept = sweepOverdue(rec, TODAY);
declareDefault(rec, 'inv_1', TODAY);
const afterDefault = { invoice_status: status(rec), event: event(rec), balances: balances(rec) };
const first = collectRepurchase(rec, 'inv_1', 20000);
const afterPartial = { invoice_status: status(rec), event: event(rec), balances: balances(rec) };
const second = collectRepurchase(rec, 'inv_1', 29301);
const afterFull = { invoice_status: status(rec), event: event(rec), balances: balances(rec) };
let overpay: string = '';
try { collectRepurchase(rec, 'inv_1', 1); } catch (e: any) { overpay = String(e.message); }

// --- non-recourse: the desk takes the loss on the day it is declared -------------------------
const non = book('non_recourse', 'US');
sweepOverdue(non, TODAY);
declareDefault(non, 'inv_1', TODAY);
const afterNonRecourse = { invoice_status: status(non), event: event(non), balances: balances(non) };
let noClaim: string = '';
try { collectRepurchase(non, 'inv_1', 1000); } catch (e: any) { noClaim = String(e.message); }

// --- recourse abandoned after a partial: only the remainder is written off -------------------
const bad = book('recourse', 'US');
sweepOverdue(bad, TODAY);
declareDefault(bad, 'inv_1', TODAY);
collectRepurchase(bad, 'inv_1', 30000);
const writtenOff = writeOffClaim(bad, 'inv_1');
const afterWriteOff = { invoice_status: status(bad), event: event(bad), balances: balances(bad) };

// --- the grace period is a country setting, measured on identical dates ----------------------
// Six days past due: outside the five the US profile allows, inside the seven the GB profile allows.
const usSix = book('recourse', 'US', '2026-11-04');
const gbSix = book('recourse', 'GB', '2026-11-04');
const usSixSwept = sweepOverdue(usSix, TODAY);
const gbSixSwept = sweepOverdue(gbSix, TODAY);

// --- the term is priced, not given ----------------------------------------------------------
const withTerm = priceSlice({ faceCents: 65_000, shareBp: 8000, tenorDays: 60, band: 'B' });
const withoutTerm = priceSlice({ faceCents: 65_000, shareBp: 8000, tenorDays: 60, band: 'B', recourse: 'non_recourse' });
const bandC = priceSlice({ faceCents: 65_000, shareBp: 6000, tenorDays: 60, band: 'C', recourse: 'non_recourse' });

console.log(JSON.stringify({
  generated_at: new Date().toISOString().slice(0, 10),
  claim: 'A receivable that does not pay has a lifecycle, a term chosen before the outcome, and a ledger that refuses to book a promise as money.',
  method: 'node scripts/export-default.ts — the real src/store.ts, src/ledger.ts and src/audit.ts against an in-memory book. No PayPal call: this artefact is about the position after the debtor fails to pay, which the book owns entirely. The funding posting it starts from is the one captureFunding makes.',
  integrity: {
    unbalanced_transactions: unbalancedTransactions(rec),
    audit_chain: verifyChain(rec)
  },
  invoice: {
    number: 'NW-1',
    face_cents: 65000,
    due_on: '2026-11-01',
    decided_on: TODAY,
    days_past_due: 9,
    advance_cents: 49301
  },
  grace_by_profile: {
    measured_on: TODAY,
    invoice_due_on: '2026-11-04',
    days_past_due: 6,
    US: { grace_days: jurisdictionFor('US').graceDays, swept: usSixSwept.length === 1, invoice_status_after: status(usSix) },
    GB: { grace_days: jurisdictionFor('GB').graceDays, swept: gbSixSwept.length === 1, invoice_status_after: status(gbSix) },
    note: 'One invoice, one date, one set of documents. Six days past due is overdue in the United States and still funded in the United Kingdom, because the grace period is read from the debtor\'s profile — the same file that sets its tenor cap and its carrier formats.'
  },
  recourse_term_priced: {
    with_recourse: { annual_rate_bp: withTerm.annualRateBp, advance_cents: withTerm.advanceCents },
    without_recourse: { annual_rate_bp: withoutTerm.annualRateBp, advance_cents: withoutTerm.advanceCents },
    premium_bp: Number(withoutTerm.annualRateBp) - Number(withTerm.annualRateBp),
    band_c_non_recourse: { ok: bandC.ok, reason: bandC.ok ? null : bandC.reason }
  },
  recourse_chain: {
    swept: { invoice_status: 'overdue', detail: swept },
    declared_default: afterDefault,
    note_at_default: 'Recourse posts nothing. The seller owes a repurchase and this book will not report a recovery it has not received.',
    first_partial: { applied: first, ...afterPartial },
    second_partial: { applied: second, ...afterFull },
    third_payment: overpay
  },
  non_recourse_chain: {
    declared_default: afterNonRecourse,
    attempt_to_collect: noClaim,
    note: 'The outlay is credited and the funder\'s yield debited on the day of default: this is the desk\'s own loss, so it is taken immediately.'
  },
  claim_written_off_after_partial: {
    amount_written_off_cents: writtenOff.amountCents,
    ...afterWriteOff,
    note: 'Thirty thousand came back first, so only the remaining 19,301 is a loss. A claim is never written off twice.'
  },
  statuses_seen: {
    overdue: 'invoice status after the sweep',
    defaulted: 'invoice status once the default is declared',
    repurchased: 'invoice status once the claim is met in full',
    events: ['claim_open', 'written_off', 'repurchased', 'uncollectible']
  }
}, null, 2));
