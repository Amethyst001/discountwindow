// Measured probe: the debtor's record read from the rail. Pulls this account's own PayPal
// transaction history, reconciles it against the settled invoices on the book, and writes the
// artefact beside the other evidence. Whatever the rail answers — rows, an empty page, an error —
// is what gets written; the artefact records the attempt, not a hoped-for shape.
import fs from 'node:fs';
import { openDb } from '../src/db.ts';
import { config, assertSandbox } from '../src/config.ts';
import { searchTransactions } from '../src/paypal.ts';
import { normalizeTransactions, reconcileRailHistory } from '../src/rail.ts';
import { debtorHistory } from '../src/store.ts';

assertSandbox();
const db = openDb();
const debtorId = process.argv[2] ?? 'debtor-halcyon';
const debtor = db.prepare('SELECT id, legal_name, rail_ref FROM debtors WHERE id = ?').get(debtorId) as any;
if (!debtor) {
  console.error(`no debtor ${debtorId} on the book`);
  process.exit(1);
}
const end = new Date();
const start = new Date(Date.now() - 180 * 86_400_000);
const settled = (db.prepare(`
  SELECT due_on, face_cents FROM invoices WHERE debtor_id = ? AND status IN ('settled','matured')`).all(debtorId) as any[])
  .map((r) => ({ dueOn: r.due_on, amountCents: Number(r.face_cents) }));

const artefact: any = {
  probe: 'x12-rail-history',
  fetchedAt: new Date().toISOString(),
  debtor: { id: debtor.id, name: debtor.legal_name, railRef: debtor.rail_ref ?? null },
  windowDays: 180,
  settledInvoicesOnBook: settled.length,
  paypalEndpoint: 'GET /v1/reporting/transactions'
};
try {
  const body = await searchTransactions({ startDate: start.toISOString(), endDate: end.toISOString() });
  const transactions = normalizeTransactions(body);
  const declared = debtorHistory(db, debtorId, settled[0]?.amountCents ?? 100_00);
  const reconciled = reconcileRailHistory({
    declared, invoices: settled, transactions, debtorRef: debtor.rail_ref ?? ''
  });
  artefact.railTransactionsInWindow = transactions.length;
  artefact.source = reconciled.source;
  artefact.matched = reconciled.matched;
  artefact.declaredRecord = declared;
  artefact.reconciledRecord = reconciled.history;
  artefact.note = reconciled.source === 'rail'
    ? 'The scorecard below was reconciled against real rail timestamps.'
    : 'No settled invoice matched a rail transaction in the window, so the declared record stands. In the sandbox the demo debtor has no settled repayments of its own yet — the reconciliation path is exercised by tests/rail.test.ts and the RAIL_HISTORY=1 intake switch.';
  console.log(`x12: ${transactions.length} rail rows, ${reconciled.matched} matched, source=${reconciled.source}`);
} catch (err: any) {
  artefact.error = String(err?.message ?? err).slice(0, 500);
  artefact.note = 'The rail did not answer this probe. The failure is recorded, not glossed; the reconciliation logic itself is exercised offline by tests/rail.test.ts.';
  console.error('probe failed:', artefact.error);
}
fs.mkdirSync('evidence/published', { recursive: true });
fs.writeFileSync('evidence/published/x12-rail-history.json', JSON.stringify(artefact, null, 2) + '\n');
console.log('wrote evidence/published/x12-rail-history.json');
