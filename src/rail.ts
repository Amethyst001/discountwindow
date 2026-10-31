/**
 * The debtor's record, read from the rail instead of declared by the paper. The desk cannot see the
 * debtor's account — nobody outside PayPal can — but it does not need to: the debtor's past payments
 * to this desk's own account are transactions in THIS account's history, and PayPal's Transaction
 * Search returns those. Reconciling the desk's settled invoices against the rail's own timestamps
 * turns "the seller says this debtor pays on time" into "the rail shows when the money actually
 * landed".
 *
 * Everything here is pure over data the caller fetched; the transport lives in paypal.ts and the
 * decision to use the rail lives behind RAIL_HISTORY=1, because a sandbox book whose record comes
 * from a rail that may not answer is a demo that may not score twice the same way.
 */
import type { DebtorHistory } from './score.ts';

export interface RailTransaction {
  date: string;
  amountCents: number;
  status: string;
  counterpartyEmail: string | null;
  txnId: string;
}

/**
 * PayPal's transaction search rows, normalised. The amount arrives as a string in `amount.value`;
 * the counterparty in `payer_info.email_address` — a field the search returns for payments this
 * account received, which is precisely the side a debtor's repayment comes from.
 */
export function normalizeTransactions(apiBody: any): RailTransaction[] {
  const rows: any[] = Array.isArray(apiBody?.transaction_details) ? apiBody.transaction_details : [];
  const out: RailTransaction[] = [];
  for (const row of rows) {
    const info = row?.transaction_info ?? {};
    const amountValue = Number(info?.transaction_amount?.value ?? NaN);
    if (!Number.isFinite(amountValue)) continue;
    out.push({
      date: String(info?.transaction_initiation_date ?? info?.transaction_note ?? '').slice(0, 10),
      amountCents: Math.round(amountValue * 100),
      status: String(info?.transaction_status ?? ''),
      counterpartyEmail: info?.payer_info?.email_address ? String(info.payer_info.email_address).toLowerCase() : null,
      txnId: String(info?.transaction_id ?? '')
    });
  }
  return out;
}

const DAY = 86_400_000;

/**
 * Reconcile the desk's settled invoices against the rail. A settled invoice matches a rail
 * transaction of the same amount, from the debtor's rail reference, dated within 45 days of the
 * due date — beyond that the money and the paper are not the same event, and guessing otherwise
 * would be the desk inventing its own comfort. The days late come from the rail's date, never from
 * the book's.
 */
export function reconcileRailHistory(input: {
  declared: DebtorHistory;
  invoices: { dueOn: string; amountCents: number }[];
  transactions: RailTransaction[];
  debtorRef: string;
}): { history: DebtorHistory; source: 'rail' | 'declared'; matched: number } {
  const ref = input.debtorRef.toLowerCase();
  const candidates = input.transactions.filter((t) => t.counterpartyEmail === ref && t.status.toUpperCase() === 'P');
  const lateness: number[] = [];
  const used = new Set<string>();
  for (const inv of input.invoices) {
    const dueMs = Date.parse(inv.dueOn + 'T00:00:00Z');
    if (!Number.isFinite(dueMs)) continue;
    const hit = candidates.find((t) =>
      !used.has(t.txnId) &&
      t.amountCents === inv.amountCents &&
      Math.abs(Date.parse(t.date + 'T00:00:00Z') - dueMs) <= 45 * DAY);
    if (!hit) continue;
    used.add(hit.txnId);
    lateness.push(Math.max(0, Math.round((Date.parse(hit.date + 'T00:00:00Z') - dueMs) / DAY)));
  }
  if (lateness.length === 0) {
    return { history: input.declared, source: 'declared', matched: 0 };
  }
  const onTimeFromRail = lateness.filter((d) => d === 0).length;
  const averageLate = lateness.reduce((a, d) => a + d, 0) / lateness.length;
  const history: DebtorHistory = {
    ...input.declared,
    invoicesDue: input.declared.invoicesDue + lateness.length,
    paidOnTime: input.declared.paidOnTime + onTimeFromRail,
    daysLateAverage: Number(averageLate.toFixed(1))
  };
  return { history, source: 'rail', matched: lateness.length };
}
