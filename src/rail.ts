/**
 * The debtor's record, read from the rail instead of declared by the paper. The desk cannot see the
 * debtor's account — nobody outside PayPal can — but it does not need to. There are two honest
 * sources, and the desk prefers the stronger one:
 *
 *   1. The desk's own maturity captures. When the debtor pays an invoice at maturity, the app
 *      captures that order in the desk's own PayPal account and stores the capture ids. Reading
 *      `GET /v2/payments/captures/{id}` gives the rail's own `create_time` and status for exactly
 *      that invoice (`custom_id` carries the invoice id). This is the same account, the same payer,
 *      and no matching by amount or email is required.
 *   2. Transaction Search over the desk's account, for a debtor whose payments predate this book.
 *      A row counts only when its status is `S` (settled). `P` is pending: it has not landed, so it
 *      cannot make a debtor look on time. Ignoring `P` was the bug this comment replaces.
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
 * A capture the desk itself created, read back from `GET /v2/payments/captures/{id}`. `invoiceId`
 * comes from `custom_id`, which every purchase unit in this build carries; when PayPal omits it the
 * caller passes the invoice id it already knows.
 */
export interface CapturePayment {
  invoiceId: string;
  captureId: string;
  date: string;
  amountCents: number;
  status: string;
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
      status: String(info?.transaction_status ?? '').toUpperCase(),
      counterpartyEmail: info?.payer_info?.email_address ? String(info.payer_info.email_address).toLowerCase() : null,
      txnId: String(info?.transaction_id ?? '')
    });
  }
  return out;
}

/**
 * The capture shape PayPal returns. A capture carries the amount, the status and the timestamp of
 * the movement; `custom_id` is echoed from the purchase unit that created it. Junk rows are dropped
 * rather than guessed at.
 */
export function normalizeCaptures(apiBodies: any[], invoiceIdByCapture: Record<string, string> = {}): CapturePayment[] {
  const out: CapturePayment[] = [];
  for (const body of apiBodies) {
    if (!body || typeof body !== 'object') continue;
    const amountValue = Number(body?.amount?.value ?? NaN);
    const captureId = String(body?.id ?? '');
    if (!captureId || !Number.isFinite(amountValue)) continue;
    const invoiceId = String(body?.custom_id ?? invoiceIdByCapture[captureId] ?? '');
    if (!invoiceId) continue;
    out.push({
      invoiceId,
      captureId,
      date: String(body?.create_time ?? body?.update_time ?? '').slice(0, 10),
      amountCents: Math.round(amountValue * 100),
      status: String(body?.status ?? '').toUpperCase()
    });
  }
  return out;
}

const DAY = 86_400_000;

function reconcile(input: {
  declared: DebtorHistory;
  matches: { date: string; dueOn: string }[];
}): { history: DebtorHistory; matched: number } {
  const lateness: number[] = [];
  for (const match of input.matches) {
    const dueMs = Date.parse(match.dueOn + 'T00:00:00Z');
    const paidMs = Date.parse(match.date + 'T00:00:00Z');
    if (!Number.isFinite(dueMs) || !Number.isFinite(paidMs)) continue;
    // A payment outside the window is not this invoice's payment, however convenient it would be.
    if (Math.abs(paidMs - dueMs) > 45 * DAY) continue;
    lateness.push(Math.max(0, Math.round((paidMs - dueMs) / DAY)));
  }
  if (lateness.length === 0) return { history: input.declared, matched: 0 };
  const onTimeFromRail = lateness.filter((d) => d === 0).length;
  const averageLate = lateness.reduce((a, d) => a + d, 0) / lateness.length;
  return {
    matched: lateness.length,
    history: {
      ...input.declared,
      invoicesDue: input.declared.invoicesDue + lateness.length,
      paidOnTime: input.declared.paidOnTime + onTimeFromRail,
      daysLateAverage: Number(averageLate.toFixed(1))
    }
  };
}

/**
 * The strong source: the desk's own maturity captures, matched to the invoice that produced them.
 * A maturity payment is split across payees, so the matching unit is the **sum** of the captures
 * carrying one invoice's `custom_id`, compared with the face — a single unit equal to the face is
 * only the degenerate one-payee case. A capture that is not `COMPLETED` has not settled and is
 * excluded from the sum; counting a PENDING unit as landed would be the desk marking its own
 * homework. The date is the last unit to land, which is when the invoice was actually paid.
 */
export function reconcileCaptureHistory(input: {
  declared: DebtorHistory;
  invoices: { invoiceId: string; dueOn: string; amountCents: number }[];
  captures: CapturePayment[];
}): { history: DebtorHistory; source: 'rail-capture' | 'declared'; matched: number } {
  const paidByInvoice = new Map<string, { cents: number; date: string }>();
  for (const c of input.captures) {
    if (c.status !== 'COMPLETED') continue;
    const acc = paidByInvoice.get(c.invoiceId) ?? { cents: 0, date: '' };
    acc.cents += c.amountCents;
    if (c.date > acc.date) acc.date = c.date;
    paidByInvoice.set(c.invoiceId, acc);
  }
  const matches: { date: string; dueOn: string }[] = [];
  for (const inv of input.invoices) {
    const paid = paidByInvoice.get(inv.invoiceId);
    if (!paid) continue;
    if (paid.cents !== inv.amountCents) continue; // a partial payment is not the invoice
    matches.push({ date: paid.date, dueOn: inv.dueOn });
  }
  const result = reconcile({ declared: input.declared, matches });
  if (result.matched === 0) return { history: input.declared, source: 'declared', matched: 0 };
  return { history: result.history, source: 'rail-capture', matched: result.matched };
}

/**
 * Reconcile the desk's settled invoices against Transaction Search. A settled invoice matches a
 * rail transaction of the same amount, from the debtor's rail reference, dated within 45 days of
 * the due date — beyond that the money and the paper are not the same event, and guessing otherwise
 * would be the desk inventing its own comfort. The days late come from the rail's date, never from
 * the book's.
 *
 * Only `S` (settled) counts. `P` (pending) is a payment that has not landed; `V`, `D`, `F` are
 * reversals, denials and failures. None of those may improve a debtor's record.
 */
export function reconcileRailHistory(input: {
  declared: DebtorHistory;
  invoices: { dueOn: string; amountCents: number }[];
  transactions: RailTransaction[];
  debtorRef: string;
}): { history: DebtorHistory; source: 'rail-search' | 'declared'; matched: number } {
  const ref = input.debtorRef.toLowerCase();
  const candidates = input.transactions.filter((t) => t.counterpartyEmail === ref && t.status.toUpperCase() === 'S');
  const used = new Set<string>();
  const matches: { date: string; dueOn: string }[] = [];
  for (const inv of input.invoices) {
    const hit = candidates.find((t) => !used.has(t.txnId) && t.amountCents === inv.amountCents);
    if (!hit) continue;
    used.add(hit.txnId);
    matches.push({ date: hit.date, dueOn: inv.dueOn });
  }
  const result = reconcile({ declared: input.declared, matches });
  if (result.matched === 0) return { history: input.declared, source: 'declared', matched: 0 };
  return { history: result.history, source: 'rail-search', matched: result.matched };
}
