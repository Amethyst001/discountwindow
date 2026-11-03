// The rail-sourced debtor record, pure: what PayPal's search body becomes, what a capture read back
// becomes, and what reconciling either against the desk's settled invoices is allowed to change. No
// network — the transport is a different file, and the decision to use it is an env flag away from
// every test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransactions, normalizeCaptures, reconcileRailHistory, reconcileCaptureHistory } from '../src/rail.ts';

const declared = {
  invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
  limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
};

test('the search body normalises into rail rows, and junk rows do not survive', () => {
  const rows = normalizeTransactions({
    transaction_details: [
      { transaction_info: { transaction_id: 'X1', transaction_status: 'S', transaction_initiation_date: '2026-10-01T11:00:00Z', transaction_amount: { currency_code: 'USD', value: '3300.00' }, payer_info: { email_address: 'Debtor@Example.com' } } },
      { transaction_info: { transaction_id: 'X2', transaction_status: 'S', transaction_amount: { value: 'not-a-number' } } }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountCents, 330_000);
  assert.equal(rows[0].counterpartyEmail, 'debtor@example.com');
  assert.equal(rows[0].date, '2026-10-01');
});

test('a settled rail hit moves days-late from the paper to the rail', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [{ date: '2026-10-04', amountCents: 330_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.source, 'rail-search');
  assert.equal(out.matched, 1);
  assert.equal(out.history.daysLateAverage, 3);
  assert.equal(out.history.paidOnTime, declared.paidOnTime, 'three days late is not on time');
  assert.equal(out.history.invoicesDue, declared.invoicesDue + 1);
});

test('a pending payment has not landed, so it cannot make a debtor look on time', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [{ date: '2026-10-01', amountCents: 330_000, status: 'P', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(out.source, 'declared');
  assert.equal(out.matched, 0);
  assert.deepEqual(out.history, declared);
});

test('a payment that landed on the due date counts as paid on time', () => {
  const out = reconcileRailHistory({
    declared,
    invoices: [{ dueOn: '2026-10-01', amountCents: 330_000 }],
    transactions: [{ date: '2026-10-01', amountCents: 330_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }],
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
      { date: '2026-10-01', amountCents: 330_000, status: 'S', counterpartyEmail: 'someone-else@example.com', txnId: 'A' },
      { date: '2026-10-01', amountCents: 990_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'B' }
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
      { date: '2026-10-02', amountCents: 330_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'X1' },
      { date: '2026-10-02', amountCents: 330_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'X2' }
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
      { date: '2026-10-02', amountCents: 330_000, status: 'S', counterpartyEmail: 'debtor@example.com', txnId: 'X1' }
    ],
    debtorRef: 'debtor@example.com'
  });
  assert.equal(single.matched, 1, 'the same rail row is not spent twice');
});

test('a capture read back is matched by its own invoice id, not by amount or email', () => {
  const captures = normalizeCaptures([{
    id: 'CAP1', status: 'COMPLETED', custom_id: 'inv_1',
    create_time: '2026-10-03T09:00:00Z', amount: { currency_code: 'USD', value: '3300.00' }
  }]);
  assert.equal(captures.length, 1);
  const out = reconcileCaptureHistory({
    declared,
    invoices: [{ invoiceId: 'inv_1', dueOn: '2026-10-01', amountCents: 330_000 }],
    captures
  });
  assert.equal(out.source, 'rail-capture');
  assert.equal(out.matched, 1);
  assert.equal(out.history.daysLateAverage, 2);
});

test('a capture that is not COMPLETED is not a payment record', () => {
  const captures = normalizeCaptures([{
    id: 'CAP1', status: 'PENDING', custom_id: 'inv_1',
    create_time: '2026-10-01T09:00:00Z', amount: { value: '3300.00' }
  }]);
  const out = reconcileCaptureHistory({
    declared,
    invoices: [{ invoiceId: 'inv_1', dueOn: '2026-10-01', amountCents: 330_000 }],
    captures
  });
  assert.equal(out.source, 'declared');
  assert.equal(out.matched, 0);
});

test('a capture for a different amount is a partial payment, not this invoice', () => {
  const captures = normalizeCaptures([{
    id: 'CAP1', status: 'COMPLETED', custom_id: 'inv_1',
    create_time: '2026-10-01T09:00:00Z', amount: { value: '100.00' }
  }]);
  const out = reconcileCaptureHistory({
    declared,
    invoices: [{ invoiceId: 'inv_1', dueOn: '2026-10-01', amountCents: 330_000 }],
    captures
  });
  assert.equal(out.source, 'declared');
});

test('a maturity split matches on the sum of its units, and dates from the last one to land', () => {
  const captures = normalizeCaptures([
    { id: 'CAP-F', status: 'COMPLETED', custom_id: 'inv_1', create_time: '2026-10-02T09:00:00Z', amount: { value: '3000.00' } },
    { id: 'CAP-S', status: 'COMPLETED', custom_id: 'inv_1', create_time: '2026-10-03T09:00:00Z', amount: { value: '300.00' } }
  ]);
  const out = reconcileCaptureHistory({
    declared,
    invoices: [{ invoiceId: 'inv_1', dueOn: '2026-10-01', amountCents: 330_000 }],
    captures
  });
  assert.equal(out.source, 'rail-capture');
  assert.equal(out.matched, 1);
  assert.equal(out.history.daysLateAverage, 2, 'the invoice is paid when the last unit lands');
});

test('one PENDING unit does not complete the sum', () => {
  const captures = normalizeCaptures([
    { id: 'CAP-F', status: 'COMPLETED', custom_id: 'inv_1', create_time: '2026-10-01T09:00:00Z', amount: { value: '3000.00' } },
    { id: 'CAP-S', status: 'PENDING', custom_id: 'inv_1', create_time: '2026-10-01T09:00:00Z', amount: { value: '300.00' } }
  ]);
  const out = reconcileCaptureHistory({
    declared,
    invoices: [{ invoiceId: 'inv_1', dueOn: '2026-10-01', amountCents: 330_000 }],
    captures
  });
  assert.equal(out.source, 'declared');
  assert.equal(out.matched, 0);
});

test('a capture with no invoice id is dropped rather than guessed at', () => {
  const captures = normalizeCaptures([{
    id: 'CAP1', status: 'COMPLETED', create_time: '2026-10-01T09:00:00Z', amount: { value: '3300.00' }
  }]);
  assert.equal(captures.length, 0);
});
