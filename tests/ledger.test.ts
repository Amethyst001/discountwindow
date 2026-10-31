import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import {
  postTransaction,
  postFunding,
  postMaturity,
  accountBalance,
  unbalancedTransactions,
  LedgerError
} from '../src/ledger.ts';

function freshDb() {
  return openDb(':memory:');
}

test('a balanced transaction posts and moves the named accounts', () => {
  const db = freshDb();
  postTransaction(db, 'txn-1', [
    { code: 'a', kind: 'asset', debit: 500, memo: 'in' },
    { code: 'b', kind: 'liability', credit: 500, memo: 'out' }
  ]);
  assert.equal(accountBalance(db, 'a'), 500);
  assert.equal(accountBalance(db, 'b'), -500);
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('an unbalanced transaction is rejected before any row is written', () => {
  const db = freshDb();
  assert.throws(
    () => postTransaction(db, 'txn-bad', [
      { code: 'a', kind: 'asset', debit: 500, memo: 'in' },
      { code: 'b', kind: 'liability', credit: 400, memo: 'out' }
    ]),
    (err: unknown) => err instanceof LedgerError && /does not balance/.test((err as Error).message)
  );
  const rows = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number };
  assert.equal(rows.n, 0);
});

test('a single-sided leg must sit on exactly one side, in whole positive cents', () => {
  const db = freshDb();
  const other = { code: 'b', kind: 'liability' as const, credit: 100, memo: 'out' };
  const cases: [string, any][] = [
    ['both sides', { code: 'a', kind: 'asset', debit: 100, credit: 100, memo: 'x' }],
    ['neither side', { code: 'a', kind: 'asset', memo: 'x' }],
    ['negative', { code: 'a', kind: 'asset', debit: -100, memo: 'x' }],
    ['fractional', { code: 'a', kind: 'asset', debit: 100.5, memo: 'x' }]
  ];
  for (const [label, leg] of cases) {
    assert.throws(() => postTransaction(db, `txn-${label}`, [leg, other]), LedgerError, label);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 0);
});

test('the ledger is append-only in the database itself, not only in application code', () => {
  const db = freshDb();
  postTransaction(db, 'txn-1', [
    { code: 'a', kind: 'asset', debit: 500, memo: 'in' },
    { code: 'b', kind: 'liability', credit: 500, memo: 'out' }
  ]);
  assert.throws(() => db.exec("UPDATE ledger_entries SET debit_cents = 1 WHERE txn_id = 'txn-1'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM ledger_entries WHERE txn_id = 'txn-1'"), /append-only/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 2);
});

test('the table itself refuses a zero-on-both-sides line even if a trigger were dropped', () => {
  const db = freshDb();
  postTransaction(db, 'txn-1', [
    { code: 'a', kind: 'asset', debit: 500, memo: 'in' },
    { code: 'b', kind: 'liability', credit: 500, memo: 'out' }
  ]);
  const accountId = (db.prepare("SELECT id FROM ledger_accounts WHERE code = 'a'").get() as { id: string }).id;
  assert.throws(
    () => db.prepare('INSERT INTO ledger_entries (id, txn_id, account_id, debit_cents, credit_cents, memo, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('le_x', 'txn-2', accountId, 0, 0, 'nothing', '2026-10-30T00:00:00Z'),
    /CHECK/
  );
});

test('funding then maturity returns the funder outlay to zero and leaves the face in clearing', () => {
  const db = freshDb();
  // The pinned worked example: face 4,800,000; advance 2,796,450; platform fee 64,357.
  const advance = 2_796_450;
  const platformFee = 64_357;
  const face = 4_800_000;
  const paypalFee = 139_200;
  postFunding(db, 'inv-1', 'funder-1', 'seller-1', { advanceCents: advance, platformFeeCents: platformFee });

  assert.equal(accountBalance(db, 'funder:funder-1:outlay'), advance);
  assert.equal(accountBalance(db, 'seller:seller-1:advance'), -advance + platformFee);
  assert.equal(accountBalance(db, 'platform:fee_revenue'), -platformFee);

  const net = face - paypalFee;
  const funderNet = Math.round(net * 6000 / 10000);
  postMaturity(db, 'inv-1', 'funder-1', 'seller-1', {
    faceCents: face,
    paypalFeeCents: paypalFee,
    funderOutlayCents: advance,
    funderNetCents: funderNet,
    sellerNetCents: net - funderNet
  });

  assert.equal(accountBalance(db, 'funder:funder-1:outlay'), 0, 'the funder has its principal back');
  assert.equal(accountBalance(db, 'platform:clearing'), face, 'clearing holds the whole face');
  assert.equal(accountBalance(db, 'funder:funder-1:yield'), -30);
  assert.equal(accountBalance(db, 'platform:fee_expense'), -paypalFee);
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('a settlement that pays the funder less than it advanced posts a debit, not a negative credit', () => {
  const db = freshDb();
  const advance = 2_796_450;
  postFunding(db, 'inv-2', 'funder-1', 'seller-1', { advanceCents: advance, platformFeeCents: 64_357 });
  postMaturity(db, 'inv-2', 'funder-1', 'seller-1', {
    faceCents: 4_800_000,
    paypalFeeCents: 139_200,
    funderOutlayCents: advance,
    funderNetCents: advance - 500,
    sellerNetCents: 4_800_000 - 139_200 - (advance - 500)
  });
  const loss = db.prepare(
    "SELECT e.debit_cents AS d, e.credit_cents AS c FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'funder:funder-1:yield'"
  ).get() as { d: number; c: number };
  assert.equal(loss.d, 500);
  assert.equal(loss.c, 0);
  assert.deepEqual(unbalancedTransactions(db), []);
});
