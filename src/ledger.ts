import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './db.ts';
import type { Cents } from './money.ts';

export type AccountKind = 'asset' | 'liability' | 'revenue' | 'equity';

export interface Leg {
  code: string;
  kind: AccountKind;
  owner?: string | null;
  debit?: Cents;
  credit?: Cents;
  memo: string;
}

export class LedgerError extends Error {}

export function ensureAccount(db: DatabaseSync, code: string, kind: AccountKind, owner: string | null = null): string {
  const existing = db.prepare('SELECT id FROM ledger_accounts WHERE code = ?').get(code) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId('acct');
  db.prepare('INSERT INTO ledger_accounts (id, code, kind, owner_ref) VALUES (?, ?, ?, ?)').run(id, code, kind, owner);
  return id;
}

/**
 * Posts one balanced transaction. Every leg must be an integer number of cents on exactly one
 * side. The rows are written inside a savepoint and the balance is re-read from the table, not
 * from the input, so a bug in the arithmetic above cannot post an unbalanced transaction.
 */
export function postTransaction(db: DatabaseSync, txnId: string, legs: Leg[], when = nowIso()): void {
  if (legs.length === 0) throw new LedgerError('a transaction needs at least one leg');
  let debits = 0;
  let credits = 0;
  for (const leg of legs) {
    const d = leg.debit ?? 0;
    const c = leg.credit ?? 0;
    if ((d === 0) === (c === 0)) throw new LedgerError(`leg ${leg.code} must be on exactly one side`);
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c)) throw new LedgerError(`leg ${leg.code} is not integer cents`);
    if (d < 0 || c < 0) throw new LedgerError(`leg ${leg.code} is negative`);
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new LedgerError(`transaction ${txnId} does not balance: debits ${debits} credits ${credits}`);
  }

  db.exec('SAVEPOINT post');
  try {
    const insert = db.prepare(
      'INSERT INTO ledger_entries (id, txn_id, account_id, debit_cents, credit_cents, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const leg of legs) {
      const accountId = ensureAccount(db, leg.code, leg.kind, leg.owner ?? null);
      insert.run(newId('le'), txnId, accountId, leg.debit ?? 0, leg.credit ?? 0, leg.memo, when);
    }
    const row = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM ledger_entries WHERE txn_id = ?').get(txnId) as { d: number; c: number };
    if (row.d !== row.c) throw new LedgerError(`transaction ${txnId} is unbalanced in the table: ${row.d} vs ${row.c}`);
    db.exec('RELEASE post');
  } catch (err) {
    db.exec('ROLLBACK TO post');
    db.exec('RELEASE post');
    throw err;
  }
}

export function unbalancedTransactions(db: DatabaseSync): any[] {
  return db.prepare('SELECT * FROM v_unbalanced_txns').all();
}

export function accountBalance(db: DatabaseSync, code: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(e.debit_cents), 0) AS d, COALESCE(SUM(e.credit_cents), 0) AS c
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = ?`
  ).get(code) as { d: number; c: number };
  return Number(row.d) - Number(row.c);
}

export interface DefaultPosting {
  funderOutlayCents: Cents;
  recourse: 'recourse' | 'non_recourse';
}

/**
 * The debtor did not pay and the position is being closed.
 *
 * Only the non-recourse branch posts here. On recourse paper the seller owes a repurchase, and a
 * promise to pay is not an asset: the claim is recorded in `default_events` and the ledger waits for
 * the money. Booking the seller's obligation as a recovery on the day of default would let the desk
 * report a loss it has not yet taken, which is the error this whole build exists to avoid.
 */
export function postDefault(db: DatabaseSync, invoiceId: string, funderId: string, p: DefaultPosting): string | null {
  if (p.recourse === 'recourse') return null;
  const txnId = `default:${invoiceId}:${funderId}`;
  postTransaction(db, txnId, [
    { code: `funder:${funderId}:yield`, kind: 'revenue', owner: funderId, debit: p.funderOutlayCents, memo: 'debtor never paid; the outlay is written against the funder\'s position' },
    { code: `funder:${funderId}:outlay`, kind: 'asset', owner: funderId, credit: p.funderOutlayCents, memo: 'receivable written off without recourse' }
  ]);
  return txnId;
}

/** The seller repurchases: cash arrives and the funder's outlay is returned by that, not by the debtor. */
export function postRepurchase(db: DatabaseSync, invoiceId: string, funderId: string, amountCents: Cents): string {
  const txnId = `repurchase:${invoiceId}:${funderId}`;
  postTransaction(db, txnId, [
    { code: 'platform:clearing', kind: 'asset', debit: amountCents, memo: 'seller repurchased the paper' },
    { code: `funder:${funderId}:outlay`, kind: 'asset', owner: funderId, credit: amountCents, memo: 'funder made whole from the seller, not the debtor' }
  ]);
  return txnId;
}

/** The recourse claim itself goes bad: the same loss posting, differently described. */
export function postClaimWriteOff(db: DatabaseSync, invoiceId: string, funderId: string, amountCents: Cents): string {
  const txnId = `claim:${invoiceId}:${funderId}:written-off`;
  postTransaction(db, txnId, [
    { code: `funder:${funderId}:yield`, kind: 'revenue', owner: funderId, debit: amountCents, memo: 'the seller did not meet the repurchase; the loss stands' },
    { code: `funder:${funderId}:outlay`, kind: 'asset', owner: funderId, credit: amountCents, memo: 'recourse claim written off' }
  ]);
  return txnId;
}

export interface FundingSplit {
  advanceCents: Cents;
  platformFeeCents: Cents;
}

/** Funder pays; seller and platform are paid, in the same capture. */
export function postFunding(db: DatabaseSync, invoiceId: string, funderId: string, sellerId: string, split: FundingSplit): string {
  const txnId = `fund:${invoiceId}:${funderId}`;
  postTransaction(db, txnId, [
    { code: `funder:${funderId}:outlay`, kind: 'asset', owner: funderId, debit: split.advanceCents, memo: 'funder outlay for a verified slice' },
    { code: `seller:${sellerId}:advance`, kind: 'liability', owner: sellerId, credit: split.advanceCents - split.platformFeeCents, memo: 'advance paid to seller' },
    { code: 'platform:fee_revenue', kind: 'revenue', credit: split.platformFeeCents, memo: 'origination fee' }
  ]);
  return txnId;
}

export interface MaturitySplit {
  faceCents: Cents;
  paypalFeeCents: Cents;
  funderOutlayCents: Cents;
  funderNetCents: Cents;
  sellerNetCents: Cents;
}

/**
 * The debtor pays face. PayPal withholds its fee. The net is allocated by ownership.
 * The fee is posted to a contra-revenue account so the receipt shows what was taken rather than
 * quietly shrinking the distribution.
 */
export function postMaturity(db: DatabaseSync, invoiceId: string, funderId: string, sellerId: string, split: MaturitySplit): string {
  const txnId = `mature:${invoiceId}`;
  const legs: Leg[] = [
    { code: 'platform:clearing', kind: 'asset', debit: split.faceCents, memo: 'debtor paid face value' },
    { code: 'platform:fee_expense', kind: 'revenue', credit: split.paypalFeeCents, memo: 'PayPal fee taken at capture' },
    { code: `funder:${funderId}:outlay`, kind: 'asset', owner: funderId, credit: split.funderOutlayCents, memo: 'funder outlay returned' },
    { code: `seller:${sellerId}:proceeds`, kind: 'liability', owner: sellerId, credit: split.sellerNetCents, memo: 'seller share of maturity' }
  ];
  const yieldCents = split.funderNetCents - split.funderOutlayCents;
  if (yieldCents > 0) legs.push({ code: `funder:${funderId}:yield`, kind: 'revenue', owner: funderId, credit: yieldCents, memo: 'funder yield' });
  else if (yieldCents < 0) legs.push({ code: `funder:${funderId}:yield`, kind: 'revenue', owner: funderId, debit: -yieldCents, memo: 'funder loss' });
  postTransaction(db, txnId, legs);
  return txnId;
}
