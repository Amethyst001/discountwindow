import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './db.ts';
import { appendAudit } from './audit.ts';
import { formatCents } from './money.ts';

/**
 * When a receivable is sold, the debtor has to be told — a debtor who pays the original seller in
 * good faith generally discharges the debt, whatever the desk's book says. So the notice is not
 * stationery; it is the step that makes the purchase effective, and this desk keeps a copy of it,
 * hashed and audited, next to the capture that paid for it.
 *
 * What the notice says is derived from stored rows only: the invoice, the parties, the funder whose
 * money actually moved. Nothing in it is composed by a model, because a document that tells a debtor
 * where to send money is the last place an invented field would be forgiven.
 */
export function assignmentNoticeText(db: DatabaseSync, invoiceId: string, sentOn = nowIso().slice(0, 10)): string | null {
  const row = db.prepare(`
    SELECT i.id, i.invoice_number, i.face_cents, i.currency, i.issued_on, i.due_on, i.status,
           s.legal_name AS seller_name, d.legal_name AS debtor_name, d.billing_address_json
      FROM invoices i JOIN sellers s ON s.id = i.seller_id JOIN debtors d ON d.id = i.debtor_id
     WHERE i.id = ?`).get(invoiceId) as any;
  if (!row) return null;
  // A partially funded receivable has been assigned in part. Telling the debtor to pay the desk while
  // the seller still owns a share of it would be the desk inventing a clean title it does not have.
  if (row.status !== 'funded') return null;

  const funders = db.prepare(`
    SELECT f.legal_name, f.paypal_email, SUM(sl.principal_cents) AS cents
      FROM slices sl LEFT JOIN funders f ON f.id = sl.funder_id
     WHERE sl.invoice_id = ? AND sl.status = 'paid'
     GROUP BY f.id, f.legal_name, f.paypal_email
     ORDER BY MIN(sl.created_at)`).all(invoiceId) as any[];
  if (funders.length === 0) return null;
  const address = (() => { try { return JSON.parse(row.billing_address_json ?? '{}'); } catch { return {}; } })();
  // The advance can be booked on the desk while the rail still reports the capture as PENDING, and a
  // notice that reads as though the money had cleared would be the desk overstating its own title. So
  // the document carries the rail's status for every capture that paid it, including the ones whose
  // status the rail never reported — a blank is not a clearance.
  const commitments = db.prepare(`
    SELECT c.capture_status AS statuses
      FROM slices sl JOIN commitments c ON c.slice_id = sl.id
     WHERE sl.invoice_id = ? AND sl.status = 'paid'`).all(invoiceId) as any[];
  const captureStatuses = commitments.flatMap((row: any) => String(row.statuses ?? '').split(','));
  const notCleared = [...new Set(captureStatuses.filter((s: string) => s !== 'COMPLETED').map((s: string) => s === '' ? 'not reported' : s))];
  const railLines = commitments.length === 0
    ? ['   No capture is recorded on the rail for this advance, so this notice rests on the desk entry.']
    : notCleared.length === 0
      ? ['   The rail reports every capture of the advance as COMPLETED.']
      : [`   The rail reports the capture of the advance as ${notCleared.join(' and ')}. If that capture`,
         '   does not clear, the purchase it pays for is reversed and this assignment never takes',
         '   effect; the desk records the reversal on this invoice the day it is reported.'];
  const lines = [
    'NOTICE OF ASSIGNMENT OF A RECEIVABLE',
    '',
    `Date:            ${sentOn}`,
    `Debtor:          ${row.debtor_name}`,
    `Address on file: ${formatAddress(address)}`,
    `Reference:       invoice ${row.invoice_number}, issued ${row.issued_on} by ${row.seller_name}, ${formatCents(Number(row.face_cents))} due ${row.due_on}`,
    '',
    '1. What happened',
    `   The right to payment of the invoice above has been purchased and assigned. ${row.seller_name}`,
    '   no longer collects it, and a payment made to them does not discharge what you owe.',
    ...railLines,
    '',
    '2. Who holds it now',
    ...funders.map((f: any) => `   ${f.legal_name ?? 'Funder on the desk'} — advance of ${formatCents(Number(f.cents))} (PayPal: ${f.paypal_email ?? 'on file'})`),
    '   The assignment is held through the desk, which settles payment on its own order.',
    '',
    '3. What to do',
    `   Pay ${formatCents(Number(row.face_cents))} on or before ${row.due_on} to the order the desk presents.`,
    '   Do not pay the seller directly. If you have already paid this invoice, tell the desk and',
    '   attach the settlement reference; the position is frozen rather than pursued.',
    '',
    '4. What this document is not',
    '   It is not a demand, a court filing, or legal advice. It is the record this desk keeps that the',
    '   debtor was told. Who may lawfully receive a notice, in what form, and with what authentication',
    '   is a question each jurisdiction answers differently, and this build does not model those rules',
    '   — see rules/jurisdictions.yaml, key notModelled.',
    '',
    `   Desk reference ${invoiceId}`
  ];
  return lines.join('\n');
}

function formatAddress(a: any): string {
  const parts = [a.line1 ?? a.address1, a.city, a.region ?? a.state, a.postalCode, a.countryCode].filter(Boolean);
  return parts.length ? parts.join(', ') : 'on file with the desk';
}

export interface NoticeRecord {
  noticeId: string;
  sha256: string;
  bodyText: string;
  addressee: string;
}

/** Issue it once. A second funding on the same invoice is a re-assignment, not a reminder. */
export function issueAssignmentNotice(db: DatabaseSync, invoiceId: string, sentOn = nowIso().slice(0, 10)): NoticeRecord | null {
  const existing = db.prepare('SELECT * FROM notices WHERE invoice_id = ?').get(invoiceId) as any;
  if (existing) return null;
  const body = assignmentNoticeText(db, invoiceId, sentOn);
  if (!body) return null;
  // The digest is of the exact bytes the debtor would have received, and nothing else: the hash is
  // stored in its own column and in the audit entry rather than written into the body, so re-hashing
  // the stored text can always prove it was not edited after the fact.
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const debtor = db.prepare('SELECT d.legal_name FROM invoices i JOIN debtors d ON d.id = i.debtor_id WHERE i.id = ?').get(invoiceId) as any;
  const noticeId = newId('note');
  db.prepare('INSERT INTO notices (id, invoice_id, sha256, body_text, addressee, created_at) VALUES (?,?,?,?,?,?)')
    .run(noticeId, invoiceId, sha, body, debtor?.legal_name ?? 'debtor', nowIso());
  appendAudit(db, 'notice_of_assignment', invoiceId, { noticeId, sha256: sha, addressee: debtor?.legal_name ?? null });
  return { noticeId, sha256: sha, bodyText: body, addressee: debtor?.legal_name ?? 'debtor' };
}

export function storedNotice(db: DatabaseSync, invoiceId: string): { sha256: string; body_text: string; addressee: string; created_at: string } | null {
  return (db.prepare('SELECT sha256, body_text, addressee, created_at FROM notices WHERE invoice_id = ?').get(invoiceId) as any) ?? null;
}

/** Recompute the digest from the stored bytes: a notice that was edited after the fact is caught here. */
export function noticeDigestMatches(db: DatabaseSync, invoiceId: string): boolean {
  const n = storedNotice(db, invoiceId);
  if (!n) return false;
  return crypto.createHash('sha256').update(n.body_text).digest('hex') === n.sha256;
}

export interface ServiceEntry {
  id: string;
  channel: string;
  reference: string | null;
  servedAt: string;
  enteredBy: string;
  digest: string;
}

/**
 * Write down that the desk sent the notice — the half an issuing desk has always been asked to prove.
 *
 * Nothing here is a delivery confirmation. There is no post office behind this table: the channel and
 * the reference are what an operator said, and they are stored as that. What the desk *can* prove is
 * which bytes went out, because the digest is recomputed from the stored notice rather than typed into
 * the form — so an entry certifies the text, and an operator's later edit of the text cannot retroactively
 * certify itself through an entry made before it.
 */
export function recordNoticeService(
  db: DatabaseSync,
  invoiceId: string,
  opts: { channel: string; reference?: string | null; servedAt?: string; enteredBy: string }
): ServiceEntry | null {
  const notice = db.prepare('SELECT id, sha256, body_text FROM notices WHERE invoice_id = ?').get(invoiceId) as any;
  if (!notice) return null;
  const digest = crypto.createHash('sha256').update(notice.body_text).digest('hex');
  if (digest !== notice.sha256) {
    throw new Error('The stored notice no longer matches its own digest, so nothing can be served on it. The bytes were changed after they were issued.');
  }
  const servedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.servedAt ?? '')) ? String(opts.servedAt) : nowIso().slice(0, 10);
  const id = newId('ns');
  db.prepare(`INSERT INTO notice_service (id, notice_id, invoice_id, channel, reference, reference_entered_by, digest, served_at, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, notice.id, invoiceId, opts.channel, opts.reference?.trim() || null, opts.enteredBy, digest, servedAt, nowIso());
  appendAudit(db, 'notice_served', invoiceId, {
    serviceId: id, channel: opts.channel, reference: opts.reference?.trim() || null,
    servedAt, digest, enteredBy: opts.enteredBy
  });
  return { id, channel: opts.channel, reference: opts.reference?.trim() || null, servedAt, enteredBy: opts.enteredBy, digest };
}

export function noticeServiceLog(db: DatabaseSync, invoiceId: string): ServiceEntry[] {
  return (db.prepare(`SELECT id, channel, reference, served_at, reference_entered_by, digest FROM notice_service
                      WHERE invoice_id = ? ORDER BY served_at, created_at`).all(invoiceId) as any[])
    .map((r: any) => ({
      id: r.id, channel: r.channel, reference: r.reference, servedAt: r.served_at,
      enteredBy: r.reference_entered_by, digest: r.digest
    }));
}

/**
 * The whole book's register, in the order it was written. The page shows one invoice's entries; this is
 * the file a desk hands over when someone asks "show me every notice you say you served", which is a
 * question about the book, not about one receivable. Ordered by the date the operator says it went, then
 * by when the row was written, because a register whose rows are in the order of entry is the only kind
 * a reader can check for gaps.
 */
export function noticeServiceRegister(db: DatabaseSync): {
  serviceId: string; invoiceNumber: string; debtorName: string; noticeId: string;
  channel: string; reference: string | null; enteredBy: string; servedAt: string; recordedAt: string;
  digest: string; digestStillMatches: boolean
}[] {
  const rows = db.prepare(`
    SELECT ns.id AS service_id, i.invoice_number, d.legal_name AS debtor_name, n.id AS notice_id,
           ns.channel, ns.reference, ns.reference_entered_by, ns.served_at, ns.created_at, ns.digest,
           n.body_text
      FROM notice_service ns
      JOIN notices n ON n.id = ns.notice_id
      JOIN invoices i ON i.id = ns.invoice_id
      JOIN debtors d ON d.id = i.debtor_id
     ORDER BY ns.served_at, ns.created_at, ns.id`).all() as any[];
  return rows.map((r: any) => ({
    serviceId: r.service_id, invoiceNumber: r.invoice_number, debtorName: r.debtor_name,
    noticeId: r.notice_id, channel: r.channel, reference: r.reference, enteredBy: r.reference_entered_by,
    servedAt: r.served_at, recordedAt: r.created_at, digest: r.digest,
    // The entry records the digest taken when it was written. Recomputing it from the stored bytes here
    // is what stops a register from quietly certifying a notice that was edited afterwards.
    digestStillMatches: crypto.createHash('sha256').update(String(r.body_text)).digest('hex') === r.digest
  }));
}

/**
 * The register as one file. Two things this does not do: it does not vouch that anything arrived — the
 * `attested_by` column says who typed the row, which is the honest label for it — and it does not carry
 * a cell into a spreadsheet as a formula. A reference field a counterparty controls, handed to an
 * auditor as CSV, is exactly where a `=HYPERLINK(...)` belongs, so any of the four characters a
 * spreadsheet reads as the start of one is neutralised, quotes and all.
 */
export function noticeServiceCsv(db: DatabaseSync): string {
  const header = ['served_on', 'invoice_number', 'debtor', 'notice_id', 'channel', 'reference',
    'attested_by', 'recorded_at', 'sha256_of_notice_bytes', 'bytes_still_match'];
  const cell = (v: unknown): string => {
    let s = v == null ? '' : String(v);
    if (/^[-=+@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header, ...noticeServiceRegister(db).map((r) => [
    r.servedAt, r.invoiceNumber, r.debtorName, r.noticeId, r.channel, r.reference ?? '',
    r.enteredBy, r.recordedAt, r.digest, r.digestStillMatches ? 'yes' : 'NO - EDITS AFTER THIS ENTRY'
  ] as (string | number)[])];
  return lines.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

