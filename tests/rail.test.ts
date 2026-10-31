// The rail-sourced debtor record, pure: what PayPal's search body becomes, and what reconciling it
// against the desk's settled invoices is allowed to change. No network — the transport is a
// different file, and the decision to use it is an env flag away from every test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransactions, reconcileRailHistory } from '../src/rail.ts';

const declared = {
  invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
  limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
};

test('the search body normalises into rail rows, and junk rows do not survive', () => {
  const rows = normalizeTransactions({
    transaction_details: [
      { transaction_info: { transaction_id: 'X1', transaction_status: 'P', transaction_initiation_date: '2026-10-01T11:00:00Z', transaction_amount: { currency_code: 'USD', value: '3300.00' }, payer_info: { email_address: 'Debtor@Example.com' } } },
      { transaction_info: { transaction_id: 'X2', transaction_status: 'P', transaction_amount: { value: 'not-a-number' } } }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountCents, 330_000);
  assert.equal(rows[0].counterpartyEmail, 'debtor@example.com');
  assert.equal(rows[0].date, '2026-10-01');
});

test('a rail hit moves days-late from the paper to the rail', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [{ date: '2026-10-04', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.source, 'rail');
  assert.equal(out.matched, 1);
  assert.equal(out.history.daysLateAverage, 3);
  assert.equal(out.history.paidOnTime, declared.paidOnTime, 'three days late is not on time');
  assert.equal(out.history.invoicesDue, declared.invoicesDue + 1);
});

test('a payment that landed on the due date counts as paid on time', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [{ date: '2026-10-01', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.history.paidOnTime, declared.paidOnTime + 1);
  assert.equal(out.history.daysLateAverage, 0);
});

test('no rail hit leaves the declared record, and says so', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.source, 'declared');
  assert.equal(out.matched, 0);
  assert.deepEqual(out.history, declared);
});

test('a different counterparty is not this debtor; a different amount is not this invoice', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [
      { date: '2026-10-01', amountCents: 330_000, status: 'P', counterpartyEmail: 'someone-else@example.com', txnId: 'A' },
      { date: '2026-10-01', amountCents: 990_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'B' }
    ],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.source, 'declared');
});

test('one delivery pays one invoice: a second rail row of the same amount does not match twice', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [
      { dueOn: '2026-10-01', amountCents: 330_000 },
      { dueOn: '2026-10-05', amountCents: 330_000 }
    ],
    transactions: [
      { date: '2026-10-02', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X1' },
      { date: '2026-10-02', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X2' }
    ],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.matched, 2, 'distinct transactions match distinct invoices');
  const single = reconcileRailHistory({
    declared,
    invoices: [
      { dueOn: '2026-10-01', amountCents: 330_000 },
      { dueOn: '2026-10-05', amountCents: 330_000 }
    ],
    transactions: [
      { date: '2026-10-02', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }
    ],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(single.matched, 1, 'the same rail row is not spent twice');
});
