import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './db.ts';
import { runGate, jurisdictionFor, normaliseTracker, type EvidenceBundle, type GateOutcome } from './gate.ts';
import { scoreDebtor, bandTerms, type DebtorHistory, type ScoreResult } from './score.ts';
import { priceSlice, settlementSplit, type PriceResult, type SettlementSplit, type RecourseTerm } from './price.ts';
import { postFunding, postMaturity, postDefault, postRepurchase, postClaimWriteOff } from './ledger.ts';
import { issueAssignmentNotice, noticeServiceLog } from './notice.ts';
import { appendAudit } from './audit.ts';
import { createOrder, captureOrder, captureStatusList, type PurchaseUnitSpec } from './paypal.ts';
import type { Cents } from './money.ts';

export interface CreateInvoiceInput {
  seller: { id: string; name: string; country: string; paypalMerchantId?: string };
  debtor: { id: string; name: string; aliases?: string[]; billingAddress: any; limitCents: Cents };
  invoice: EvidenceBundle['invoice'];
  pod: EvidenceBundle['pod'];
  evidenceSha256: string;
  evidenceText: string;
  /** Where the uploaded bytes went, and who read them. Absent for the seed, which has no file. */
  evidence?: { path?: string; mime?: string; bytes?: number; model?: string; modelVersion?: string; raw?: unknown; confidence?: Record<string, number>; notes?: string[] };
  protection: { status: string; trackerId?: string | null };
  /** Who stands behind the paper if the debtor never pays. Defaults to the desk's own recourse term. */
  recourse?: RecourseTerm;
  history: DebtorHistory;
  sandbox: boolean;
  allowProtectionOverride: boolean;
}

export function ensureParty(db: DatabaseSync, table: 'sellers' | 'debtors' | 'funders', row: Record<string, any>): void {
  if (table === 'sellers') {
    db.prepare('INSERT OR IGNORE INTO sellers (id, paypal_merchant_id, legal_name, country, created_at) VALUES (?,?,?,?,?)')
      .run(row.id, row.paypalMerchantId ?? null, row.name, row.country ?? 'US', nowIso());
  } else if (table === 'debtors') {
    db.prepare('INSERT OR IGNORE INTO debtors (id, legal_name, normalized_name, billing_address_json, limit_cents, created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.name, row.name.toLowerCase(), JSON.stringify(row.billingAddress), row.limitCents, nowIso());
  } else {
    db.prepare('INSERT OR IGNORE INTO funders (id, legal_name, paypal_email, created_at) VALUES (?,?,?,?)')
      .run(row.id, row.name, row.paypalEmail, nowIso());
  }
}

export interface IntakeOutcome {
  invoiceId: string;
  gate: GateOutcome;
  score: ScoreResult;
  price: PriceResult | null;
  status: string;
}

export function intakeInvoice(db: DatabaseSync, input: CreateInvoiceInput): IntakeOutcome {
  ensureParty(db, 'sellers', { ...input.seller, name: input.seller.name });
  ensureParty(db, 'debtors', { ...input.debtor, name: input.debtor.name });

  const invoiceId = newId('inv');
  const alreadyFinanced = !!db.prepare(
    'SELECT 1 FROM invoices WHERE debtor_id = ? AND invoice_number = ?'
  ).get(input.debtor.id, input.invoice.invoiceNumber);
  const reusedEvidenceOn = (db.prepare(
    'SELECT i.invoice_number FROM evidence_files e JOIN invoices i ON i.id = e.invoice_id WHERE e.sha256 = ?'
  ).get(input.evidenceSha256) as any)?.invoice_number ?? null;
  const reusedEvidence = !!reusedEvidenceOn;
  // A different file describing a parcel already on the books is the cheap forgery: reprint the
  // label, change the invoice number. The hash alone would let it through, so the tracker is
  // compared as well — normalised, because the same parcel is written several ways on paper.
  const tracker = normaliseTracker(input.pod.trackingNumber);
  const reusedTrackerOn = tracker
    ? (db.prepare(
        'SELECT i.invoice_number FROM evidence_files e JOIN invoices i ON i.id = e.invoice_id WHERE e.tracker = ?'
      ).get(tracker) as any)?.invoice_number ?? null
    : null;
  const reusedTracker = !!reusedTrackerOn;

  const bundle: EvidenceBundle = {
    pod: input.pod,
    invoice: input.invoice,
    debtor: {
      id: input.debtor.id,
      legalName: (input.debtor as any).legalName ?? input.debtor.name,
      aliases: input.debtor.aliases,
      billingAddress: input.debtor.billingAddress
    },
    evidenceSha256: input.evidenceSha256,
    reusedEvidence,
    reusedTracker,
    reusedEvidenceOn,
    reusedTrackerOn,
    alreadyFinanced,
    protection: input.protection
  };

  const gate = runGate(bundle, { sandbox: input.sandbox, allowProtectionOverride: input.allowProtectionOverride });
  const scoreResult = scoreDebtor(input.history, { railCorroborated: gate.railCorroborated });

  db.prepare(
    `INSERT INTO invoices (id, seller_id, debtor_id, invoice_number, face_cents, currency, issued_on, due_on, po_ref, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(invoiceId, input.seller.id, input.debtor.id, input.invoice.invoiceNumber, input.invoice.totalCents, 'USD',
        input.invoice.issuedOn, input.invoice.dueOn, input.invoice.poRef ?? null, 'received', nowIso());

  // One document, one row. The sha256 column is UNIQUE on purpose — it is the storage-level half of
  // E06 — so a re-upload of bytes already on the books does not get its own copy. The invoice, its
  // checks and its refusal are still written; what the seller gets back is the check that names the
  // collision, not a stack trace.
  const existingEvidence = db.prepare('SELECT id FROM evidence_files WHERE sha256 = ?').get(input.evidenceSha256) as any;
  if (!existingEvidence) {
    const evidenceId = newId('ev');
    db.prepare('INSERT INTO evidence_files (id, invoice_id, path, sha256, mime, bytes, tracker, uploaded_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(evidenceId, invoiceId, input.evidence?.path ?? `${evidenceId}.txt`, input.evidenceSha256,
           input.evidence?.mime ?? 'text/plain', input.evidence?.bytes ?? Buffer.byteLength(input.evidenceText),
           tracker, nowIso());
    db.prepare('INSERT INTO extractions (id, evidence_id, model, model_version, raw_json, fields_json, confidence_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId('ex'), evidenceId, input.evidence?.model ?? 'deterministic-text', input.evidence?.modelVersion ?? '1',
           JSON.stringify(input.evidence?.raw ?? { text: input.evidenceText }),
           JSON.stringify({ pod: input.pod, invoice: input.invoice, notes: input.evidence?.notes ?? [] }),
           JSON.stringify(input.evidence?.confidence ?? input.pod.confidence ?? {}), nowIso());
  } else if (tracker) {
    // A second invoice describing the same parcel with a different file is the case the hash alone
    // cannot see. The tracker belongs to the document that got here first, so the new number is
    // written onto the existing row rather than dropped: E06's detail names one invoice, and the
    // evidence row has to be able to say which number it is talking about.
    db.prepare('UPDATE evidence_files SET tracker = COALESCE(tracker, ?) WHERE id = ?').run(tracker, existingEvidence.id);
  }

  const insertCheck = db.prepare('INSERT INTO checks (id, invoice_id, check_id, passed, detail, rule, evidence_region, created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const c of gate.checks) {
    insertCheck.run(newId('chk'), invoiceId, c.checkId, c.passed ? 1 : 0, c.detail, c.rule, c.evidenceRegion, nowIso());
  }

  db.prepare('INSERT INTO scores (id, debtor_id, invoice_id, components_json, score, band, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(newId('sc'), input.debtor.id, invoiceId, JSON.stringify(scoreResult.components), scoreResult.score, scoreResult.band, nowIso());

  let price: PriceResult | null = null;
  let status = gate.verdict === 'REFUSED' ? 'REFUSED' : 'verified';

  if (gate.verdict === 'VERIFIED') {
    const tenorDays = Math.round((Date.parse(input.invoice.dueOn) - Date.parse(input.invoice.issuedOn)) / 86_400_000);
    price = priceSlice({
      faceCents: input.invoice.totalCents,
      shareBp: bandTerms(scoreResult.band).maxAdvanceBp,
      tenorDays,
      band: scoreResult.band,
      recourse: input.recourse
    });
    if (price.ok) {
      db.prepare(
        'INSERT INTO prices (id, invoice_id, annual_rate_bp, tenor_days, fee_reserve_cents, discount_cents, advance_cents, platform_fee_cents, recourse, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(newId('pr'), invoiceId, price.annualRateBp, tenorDays, price.feeReserveCents, price.discountCents,
            price.advanceCents, price.platformFeeCents, price.recourse, nowIso());
      status = 'priced';
    } else {
      db.prepare('INSERT INTO decisions (id, invoice_id, kind, verdict, reasons_json, inputs_hash, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(newId('dec'), invoiceId, 'pricing', 'REFUSED', JSON.stringify([{ code: 'BAND_LIMIT', rule: price.reason }]), input.evidenceSha256, nowIso());
      status = 'REFUSED';
    }
  }

  db.prepare('INSERT INTO decisions (id, invoice_id, kind, verdict, reasons_json, inputs_hash, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(newId('dec'), invoiceId, 'gate', gate.verdict, JSON.stringify(gate.refusals), input.evidenceSha256, nowIso());
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);

  appendAudit(db, 'extraction', invoiceId, {
    model: input.evidence?.model ?? 'deterministic-text',
    modelVersion: input.evidence?.modelVersion ?? '1',
    confidence: input.evidence?.confidence ?? input.pod.confidence ?? {},
    sha256: input.evidenceSha256,
    bytes: input.evidence?.bytes ?? Buffer.byteLength(input.evidenceText)
  });
  appendAudit(db, 'gate', invoiceId, {
    verdict: gate.verdict,
    refusals: gate.refusals,
    overrides: gate.overrides,
    evidenceSha256: input.evidenceSha256,
    score: scoreResult.score,
    band: scoreResult.band
  });
  if (gate.verdict === 'VERIFIED' && price?.ok) {
    appendAudit(db, 'price', invoiceId, {
      annualRateBp: price.annualRateBp,
      discountCents: price.discountCents,
      advanceCents: price.advanceCents,
      platformFeeCents: price.platformFeeCents,
      recourse: price.recourse
    });
  }

  return { invoiceId, gate, score: scoreResult, price, status };
}

/** Score inputs come from this desk's own record with the debtor, never from a bureau. */
export function debtorHistory(db: DatabaseSync, debtorId: string, faceCents: Cents): DebtorHistory {
  const debtor = db.prepare('SELECT limit_cents, created_at FROM debtors WHERE id = ?').get(debtorId) as any;
  const prior = db.prepare('SELECT * FROM debtor_history WHERE debtor_id = ?').get(debtorId) as any;
  const live = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS settled,
           SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS disputed,
           SUM(CASE WHEN status IN ('funded','partially_funded','matured','settled') THEN face_cents ELSE 0 END) AS outstanding
      FROM invoices WHERE debtor_id = ?`).get(debtorId) as any;
  const settled = Number(live.settled ?? 0);
  const total = Number(live.total ?? 0);
  const first = db.prepare('SELECT MIN(created_at) AS at FROM invoices WHERE debtor_id = ?').get(debtorId) as any;
  const monthsHere = first?.at ? Math.max(1, Math.round((Date.now() - Date.parse(first.at)) / 2_629_800_000)) : 1;
  return {
    // Only invoices that have come due count against the on-time rate; a listing in flight does not.
    invoicesDue: Number(prior?.invoices_due ?? 0) + settled,
    paidOnTime: Number(prior?.paid_on_time ?? 0) + settled,
    daysLateAverage: Number(prior?.days_late_average ?? 0),
    outstandingCents: Number(live.outstanding ?? 0) + faceCents,
    limitCents: Number(debtor?.limit_cents ?? 0),
    monthsActive: Math.max(Number(prior?.months_active ?? 0), monthsHere),
    disputes: Number(prior?.disputes ?? 0) + Number(live.disputed ?? 0),
    totalInvoices: Math.max(Number(prior?.invoices_due ?? 0) + total, 1),
    faceCents
  };
}

export function listInvoices(db: DatabaseSync, filter?: { status?: string }): any[] {
  const rows = db.prepare(`
    SELECT i.*, s.legal_name AS seller_name, d.legal_name AS debtor_name,
           (SELECT score FROM scores WHERE invoice_id = i.id ORDER BY created_at DESC LIMIT 1) AS score,
           (SELECT band FROM scores WHERE invoice_id = i.id ORDER BY created_at DESC LIMIT 1) AS band,
           (SELECT discount_cents FROM prices WHERE invoice_id = i.id ORDER BY created_at DESC LIMIT 1) AS discount_cents,
           (SELECT advance_cents FROM prices WHERE invoice_id = i.id ORDER BY created_at DESC LIMIT 1) AS advance_cents,
           (SELECT annual_rate_bp FROM prices WHERE invoice_id = i.id ORDER BY created_at DESC LIMIT 1) AS annual_rate_bp
      FROM invoices i
      JOIN sellers s ON s.id = i.seller_id
      JOIN debtors d ON d.id = i.debtor_id
     ${filter?.status ? 'WHERE i.status = ?' : ''}
     ORDER BY i.created_at DESC, i.invoice_number
  `).all(...(filter?.status ? [filter.status] : []));
  return rows as any[];
}

export function invoiceDetail(db: DatabaseSync, id: string): any | null {
  const invoice = db.prepare(`
    SELECT i.*, s.legal_name AS seller_name, s.paypal_merchant_id AS seller_merchant,
           d.legal_name AS debtor_name, d.billing_address_json, d.limit_cents
      FROM invoices i JOIN sellers s ON s.id = i.seller_id JOIN debtors d ON d.id = i.debtor_id
     WHERE i.id = ?`).get(id) as any;
  if (!invoice) return null;
  const checks = db.prepare('SELECT * FROM checks WHERE invoice_id = ? ORDER BY rowid').all(id) as any[];
  const score = db.prepare('SELECT * FROM scores WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as any;
  const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as any;
  const evidence = db.prepare('SELECT * FROM evidence_files WHERE invoice_id = ?').get(id) as any;
  const extraction = evidence ? db.prepare('SELECT * FROM extractions WHERE evidence_id = ?').get(evidence.id) as any : null;
  const audit = db.prepare('SELECT * FROM audit_log WHERE subject_id = ? ORDER BY seq').all(id) as any[];
  const slices = db.prepare(`
    SELECT sl.*, f.legal_name AS funder_name, f.paypal_email,
           c.paypal_order_id, c.capture_id, c.status AS commitment_status, c.approve_link AS funding_approve_link
      FROM slices sl
      LEFT JOIN funders f ON f.id = sl.funder_id
      LEFT JOIN commitments c ON c.slice_id = sl.id
     WHERE sl.invoice_id = ? ORDER BY sl.created_at`).all(id) as any[];
  const decisions = db.prepare('SELECT * FROM decisions WHERE invoice_id = ? ORDER BY created_at').all(id) as any[];
  const maturity = (db.prepare('SELECT * FROM maturity_orders WHERE invoice_id = ?').get(id) as any) ?? null;
  const defaultEvent = (db.prepare('SELECT * FROM default_events WHERE invoice_id = ?').get(id) as any) ?? null;
  const notice = (db.prepare('SELECT sha256, addressee, created_at FROM notices WHERE invoice_id = ?').get(id) as any) ?? null;
  // Only what the desk wrote about sending it. The page shows this to the desk view; the entries are
  // the operator's own statements, so they are not shown as though a carrier had confirmed them.
  const noticeService = noticeServiceLog(db, id);
  const resubmission = resubmissionLink(db, id);
  return { invoice, checks, score, price, evidence, extraction, audit, slices, decisions, maturity, defaultEvent, notice, noticeService, resubmission };
}

/**
 * The resubmission paper trail: the refused invoice a document corrects, and the corrected
 * receivables a refusal has produced. The refusal itself is never rewritten — this is the link that
 * keeps it terminal while the seller repairs the evidence.
 */
export function resubmissionLink(db: DatabaseSync, invoiceId: string): { of: { id: string; invoiceNumber: string; status: string } | null; corrections: { id: string; invoiceNumber: string; status: string }[] } {
  const ofRow = db.prepare(`
    SELECT r.refused_invoice_id AS id, i.invoice_number, i.status
      FROM resubmissions r JOIN invoices i ON i.id = r.refused_invoice_id
     WHERE r.invoice_id = ?`).get(invoiceId) as any;
  const corrections = db.prepare(`
    SELECT r.invoice_id AS id, i.invoice_number, i.status
      FROM resubmissions r JOIN invoices i ON i.id = r.invoice_id
     WHERE r.refused_invoice_id = ? ORDER BY r.created_at`).all(invoiceId) as any[];
  return {
    of: ofRow ? { id: ofRow.id, invoiceNumber: ofRow.invoice_number, status: ofRow.status } : null,
    corrections: corrections.map((c) => ({ id: c.id, invoiceNumber: c.invoice_number, status: c.status }))
  };
}

/**
 * The revision number a resubmission of this refused paper will carry: find the original at the
 * root of the correction chain, count every correction the chain already holds, and add one. The
 * seller's invoice number is never rewritten — it gains a revision suffix, the way a corrected
 * document does in the real world.
 */
export function nextResubmissionNumber(db: DatabaseSync, refusedInvoiceId: string): string {
  let root = refusedInvoiceId;
  for (;;) {
    const parent = db.prepare('SELECT refused_invoice_id AS p FROM resubmissions WHERE invoice_id = ?').get(root) as any;
    if (!parent?.p) break;
    root = parent.p;
  }
  const rootNumber = (db.prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(root) as any)?.invoice_number ?? '';
  // The root is revision one implicitly; every correction already in the chain takes the next
  // number, wherever in the chain it sits.
  let corrections = 0;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift() as string;
    const kids = db.prepare('SELECT invoice_id FROM resubmissions WHERE refused_invoice_id = ?').all(current) as any[];
    corrections += kids.length;
    for (const k of kids) queue.push(k.invoice_id);
  }
  return `${rootNumber}-R${corrections + 2}`;
}

/** Written by the resubmission route after the corrected intake lands. */
export function recordResubmission(db: DatabaseSync, refusedInvoiceId: string, invoiceId: string): void {
  db.prepare('INSERT INTO resubmissions (id, refused_invoice_id, invoice_id, created_at) VALUES (?,?,?,?)')
    .run(newId('rs'), refusedInvoiceId, invoiceId, nowIso());
}

export function archiveSummary(db: DatabaseSync): any[] {
  return db.prepare(`
    SELECT json_extract(payload_json, '$.refusals[0].code') AS code, COUNT(*) AS n
      FROM audit_log WHERE kind = 'gate' AND json_extract(payload_json, '$.verdict') = 'REFUSED'
     GROUP BY code ORDER BY n DESC
  `).all() as any[];
}

export function archiveCounts(db: DatabaseSync): { total: number; refused: number; verified: number; funded: number } {
  const one = (sql: string) => Number((db.prepare(sql).get() as any).n);
  return {
    total: one('SELECT COUNT(*) AS n FROM invoices'),
    refused: one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'REFUSED'"),
    verified: one("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('verified','priced','listed','funded','settled','partially_funded','matured')"),
    funded: one("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('funded','settled','matured')")
  };
}

export function ledgerRows(db: DatabaseSync): any[] {
  return db.prepare(`
    SELECT a.code AS account, a.kind, e.txn_id, e.memo,
           SUM(e.debit_cents) AS debits, SUM(e.credit_cents) AS credits, COUNT(*) AS lines
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     GROUP BY e.txn_id, a.code
     ORDER BY e.txn_id, a.code
  `).all() as any[];
}

export function ledgerTotals(db: DatabaseSync): any[] {
  return db.prepare(`
    SELECT a.code AS account, a.kind,
           SUM(e.debit_cents) AS debits, SUM(e.credit_cents) AS credits,
           SUM(e.debit_cents) - SUM(e.credit_cents) AS balance
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     GROUP BY a.code ORDER BY a.code
  `).all() as any[];
}

// ---- Funding and settlement -------------------------------------------------

export function addSlice(db: DatabaseSync, invoiceId: string, funderId: string, shareBp: number, principalCents: Cents, status = 'offered'): string {
  const id = newId('sl');
  db.prepare('INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, invoiceId, funderId, shareBp, principalCents, status, nowIso());
  return id;
}

export interface FundResult {
  orderId: string;
  approveLink: string | null;
  status: number;
  body: any;
}

/**
 * Creates the funding order. The purchase units are the seller's advance and the platform's fee,
 * so the funder's single payment settles to two payees and no balance is ever held here.
 */
export async function createFundingOrder(db: DatabaseSync, sliceId: string, sellerPayee: string, platformPayee: string): Promise<FundResult> {
  const slice = db.prepare('SELECT * FROM slices WHERE id = ?').get(sliceId) as any;
  if (!slice) throw new Error('slice not found');
  const existing = db.prepare('SELECT * FROM commitments WHERE slice_id = ?').get(sliceId) as any;
  if (existing) {
    return { orderId: existing.paypal_order_id, approveLink: existing.approve_link ?? null, status: 200, body: { reused: true } };
  }
  const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(slice.invoice_id) as any;
  const faceShare = Math.round((Number(price.advance_cents) + Number(price.discount_cents)) * slice.share_bp / 10000);
  const advance = Math.round(Number(price.advance_cents) * slice.share_bp / 10000);
  const platformFee = Math.round(Number(price.platform_fee_cents) * slice.share_bp / 10000);
  const sellerAmount = advance - platformFee;
  if (sellerAmount <= 0) throw new Error('slice is too small to fund');

  const specs: PurchaseUnitSpec[] = [
    { referenceId: 'seller', description: 'Seller advance', amountCents: sellerAmount, payeeEmail: sellerPayee, customId: slice.invoice_id },
    { referenceId: 'platform', description: 'Origination fee', amountCents: platformFee, payeeEmail: platformPayee, customId: slice.invoice_id }
  ];
  const order = await createOrder(specs, `dw-fund-${sliceId}`);
  if (order.status !== 201 && order.status !== 200) throw new Error(`funding order failed: ${order.status} ${JSON.stringify(order.body)}`);
  db.prepare('INSERT INTO commitments (id, slice_id, paypal_order_id, amount_cents, status, approve_link, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(newId('cm'), sliceId, order.id, sellerAmount + platformFee, 'created', order.approveLink, nowIso());
  db.prepare("UPDATE slices SET status = 'committed' WHERE id = ?").run(sliceId);
  db.prepare("UPDATE invoices SET status = 'partially_funded' WHERE id = ? AND status IN ('priced','listed','verified')").run(slice.invoice_id);
  appendAudit(db, 'funding_order', slice.invoice_id, { sliceId, orderId: order.id, sellerAmount, platformFee, faceShare });
  return { orderId: order.id!, approveLink: order.approveLink, status: order.status, body: order.body };
}

export async function captureFunding(db: DatabaseSync, sliceId: string): Promise<any> {
  const commitment = db.prepare('SELECT * FROM commitments WHERE slice_id = ?').get(sliceId) as any;
  if (!commitment) throw new Error('no funding order for this slice');
  if (commitment.capture_id) return { alreadyCaptured: true, captureId: commitment.capture_id };
  const captured = await captureOrder(commitment.paypal_order_id, `dw-fundcap-${sliceId}`);
  const slice = db.prepare('SELECT * FROM slices WHERE id = ?').get(sliceId) as any;
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(slice.invoice_id) as any;
  const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(slice.invoice_id) as any;

  const platformFee = Math.round(Number(price.platform_fee_cents) * slice.share_bp / 10000);
  const advance = Math.round(Number(price.advance_cents) * slice.share_bp / 10000);
  const sellerAmount = advance - platformFee;

  db.prepare('UPDATE commitments SET capture_id = ?, capture_status = ?, status = ? WHERE slice_id = ?')
    .run(captured.allocations.map((a) => a.captureId).join(','), captureStatusList(captured), 'captured', sliceId);
  db.prepare("UPDATE slices SET status = 'paid' WHERE id = ?").run(sliceId);

  postFunding(db, invoice.id, slice.funder_id ?? 'funder-1', invoice.seller_id, { advanceCents: sellerAmount + platformFee, platformFeeCents: platformFee });

  const totalBp = Number((db.prepare("SELECT COALESCE(SUM(share_bp),0) AS n FROM slices WHERE invoice_id = ? AND status IN ('paid','committed')").get(invoice.id) as any).n);
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(totalBp >= 10000 ? 'funded' : 'partially_funded', invoice.id);

  appendAudit(db, 'funding_capture', invoice.id, {
    sliceId,
    orderId: commitment.paypal_order_id,
    allocations: captured.allocations.map((a) => ({ unit: a.referenceId, payee: a.payeeEmail, cents: a.amountCents, capture: a.captureId, status: a.captureStatus }))
  });
  // A debtor who was never told may pay the original seller and discharge the debt. So the notice is
  // issued the moment the purchase is real — and only then, because a partly funded receivable has
  // not been assigned cleanly.
  if (totalBp >= 10_000) issueAssignmentNotice(db, invoice.id);
  return { captured };
}

/**
 * The rail said one of its captures cleared. `capture_status` is the desk's live answer to "has the
 * money moved", held per capture beside `capture_id`, so the webhook replaces only the status of the
 * capture it reported — a two-unit funding that is half cleared is not settled. The issued notice is
 * not rewritten: it recorded the rail's answer on the day it went out, which is the only answer a
 * document like that can carry.
 */
export function markCaptureCompleted(db: DatabaseSync, captureId: string): number {
  if (!captureId) return 0;
  const rows = db.prepare(`
    SELECT c.id AS commitment, c.capture_id AS captures, c.capture_status AS statuses, sl.invoice_id AS invoice
      FROM commitments c JOIN slices sl ON sl.id = c.slice_id
     WHERE ',' || COALESCE(c.capture_id,'') || ',' LIKE ?`).all(`%,${captureId},%`) as any[];
  let marked = 0;
  for (const row of rows) {
    const ids = String(row.captures ?? '').split(',');
    const statuses = String(row.statuses ?? '').split(',');
    while (statuses.length < ids.length) statuses.push('');
    let touched = false;
    ids.forEach((id, index) => { if (id === captureId && statuses[index] !== 'COMPLETED') { statuses[index] = 'COMPLETED'; touched = true; } });
    if (!touched) continue;
    db.prepare('UPDATE commitments SET capture_status = ? WHERE id = ?').run(statuses.join(','), row.commitment);
    appendAudit(db, 'funding_capture_completed', row.invoice, { captureId, commitment: row.commitment });
    marked += 1;
  }
  return marked;
}

export interface MaturityResult {
  orderId: string;
  approveLink: string | null;
  split: SettlementSplit;
  status: number;
  body: any;
}

function settlementContext(db: DatabaseSync, invoiceId: string) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!invoice) throw new Error('invoice not found');
  const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(invoiceId) as any;
  if (!price) throw new Error('this invoice was never priced');
  const slice = db.prepare("SELECT * FROM slices WHERE invoice_id = ? AND status = 'paid' ORDER BY share_bp DESC LIMIT 1").get(invoiceId) as any;
  if (!slice) throw new Error('no paid slice to settle');
  return { invoice, price, slice, split: settlementSplit(Number(invoice.face_cents), price) };
}

/**
 * The debtor pays the face value. The units are the funder's gross slice and the seller's
 * remainder, so one capture pays both — with no omnibus balance sitting on the platform.
 */
export async function createMaturityOrder(db: DatabaseSync, invoiceId: string): Promise<MaturityResult> {
  const { invoice, slice, split } = settlementContext(db, invoiceId);
  if (invoice.status === 'disputed') throw new Error('this invoice is frozen by a dispute');
  // Past due is not the same as closed. Until the desk actually declares default, the debtor can
  // still pay, and a late payment makes the funder whole out of the receivable rather than out of
  // the seller. Taking the settle button away at the grace boundary would invent a failure that has
  // not happened yet.
  if (invoice.status !== 'funded' && invoice.status !== 'overdue') {
    throw new Error(`only a funded invoice settles; this one is ${invoice.status}`);
  }

  const existing = db.prepare('SELECT * FROM maturity_orders WHERE invoice_id = ?').get(invoiceId) as any;
  if (existing) {
    return { orderId: existing.paypal_order_id, approveLink: existing.approve_link, split, status: 200, body: { reused: true } };
  }

  const funder = db.prepare('SELECT * FROM funders WHERE id = ?').get(slice.funder_id) as any;
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(invoice.seller_id) as any;
  const funderPayee = funder?.paypal_email;
  const sellerPayee = seller?.paypal_merchant_id;
  if (!funderPayee || !sellerPayee) throw new Error('a maturity payee is missing');

  const specs: PurchaseUnitSpec[] = [
    { referenceId: 'funder', description: 'Funder principal and yield', amountCents: split.grossFunderCents, payeeEmail: funderPayee, customId: invoiceId },
    { referenceId: 'seller', description: 'Seller residual', amountCents: split.grossSellerCents, payeeEmail: sellerPayee, customId: invoiceId }
  ];
  const order = await createOrder(specs, `dw-mature-${invoiceId}`);
  if (order.status !== 201 && order.status !== 200) throw new Error(`maturity order failed: ${order.status} ${JSON.stringify(order.body)}`);

  db.prepare('INSERT INTO maturity_orders (id, invoice_id, paypal_order_id, approve_link, funder_id, gross_funder_cents, gross_seller_cents, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(newId('mo'), invoiceId, order.id!, order.approveLink, slice.funder_id, split.grossFunderCents, split.grossSellerCents, 'created', nowIso());
  db.prepare("UPDATE invoices SET status = 'matured' WHERE id = ?").run(invoiceId);
  appendAudit(db, 'maturity_order', invoiceId, {
    orderId: order.id,
    payer: 'debtor',
    payees: [
      { ref: 'funder', payee: funderPayee, cents: split.grossFunderCents },
      { ref: 'seller', payee: sellerPayee, cents: split.grossSellerCents }
    ]
  });
  return { orderId: order.id!, approveLink: order.approveLink, split, status: order.status, body: order.body };
}

export async function captureMaturity(db: DatabaseSync, invoiceId: string): Promise<any> {
  const row = db.prepare('SELECT * FROM maturity_orders WHERE invoice_id = ?').get(invoiceId) as any;
  if (!row) throw new Error('no maturity order for this invoice');
  if (row.status === 'captured') return { alreadyCaptured: true, captures: JSON.parse(row.captures_json ?? '[]') };

  const { invoice, price, split } = settlementContext(db, invoiceId);
  const captured = await captureOrder(row.paypal_order_id, `dw-maturecap-${invoiceId}`);
  const paid = captured.allocations.reduce((acc, a) => acc + a.amountCents, 0);
  if (paid !== Number(invoice.face_cents)) {
    throw new Error(`refusing to settle: the debtor paid ${paid} against a face of ${invoice.face_cents}`);
  }

  postMaturity(db, invoiceId, row.funder_id, invoice.seller_id, {
    faceCents: Number(invoice.face_cents),
    paypalFeeCents: split.feeCents,
    funderOutlayCents: Number(price.advance_cents),
    funderNetCents: split.funderNetCents,
    sellerNetCents: split.sellerNetCents
  });
  const captures = captured.allocations.map((a) => ({
    unit: a.referenceId, payee: a.payeeEmail, cents: a.amountCents, capture: a.captureId, status: a.captureStatus
  }));
  db.prepare("UPDATE maturity_orders SET status = 'captured', captures_json = ? WHERE invoice_id = ?").run(JSON.stringify(captures), invoiceId);
  db.prepare("UPDATE slices SET status = 'settled' WHERE invoice_id = ? AND status = 'paid'").run(invoiceId);
  db.prepare("UPDATE invoices SET status = 'settled' WHERE id = ?").run(invoiceId);
  appendAudit(db, 'maturity_capture', invoiceId, { orderId: row.paypal_order_id, captures, split });
  return { captured, split, captures };
}

// ---- When the debtor does not pay -------------------------------------------

export interface SweptInvoice {
  invoiceId: string;
  invoiceNumber: string;
  daysPastDue: number;
  graceDays: number;
}

/**
 * A funded invoice whose due date and grace period have passed with nothing captured. The grace
 * period is read from the debtor's jurisdiction profile: how long a desk waits before it calls paper
 * overdue is a country setting, in the same file as the tenor cap it follows.
 */
export function sweepOverdue(db: DatabaseSync, today = nowIso().slice(0, 10)): SweptInvoice[] {
  const rows = db.prepare(`
    SELECT i.id, i.invoice_number, i.due_on, d.billing_address_json
      FROM invoices i JOIN debtors d ON d.id = i.debtor_id
     WHERE i.status IN ('funded', 'partially_funded', 'matured')`).all() as any[];
  const swept: SweptInvoice[] = [];
  for (const r of rows) {
    const countryCode = (() => { try { return JSON.parse(r.billing_address_json ?? '{}').countryCode; } catch { return undefined; } })();
    const graceDays = jurisdictionFor(countryCode).graceDays;
    const daysPastDue = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.due_on}T00:00:00Z`)) / 86_400_000);
    if (daysPastDue <= graceDays) continue;
    db.prepare("UPDATE invoices SET status = 'overdue' WHERE id = ?").run(r.id);
    appendAudit(db, 'overdue', r.id, { dueOn: r.due_on, daysPastDue, graceDays, jurisdiction: jurisdictionFor(countryCode).countryCode });
    swept.push({ invoiceId: r.id, invoiceNumber: r.invoice_number, daysPastDue, graceDays });
  }
  return swept;
}

export interface DefaultOutcome {
  mode: RecourseTerm;
  funderOutlayCents: Cents;
  claimCents: Cents;
  /** `written_off` when the desk's own underwriting takes the loss; `claim_open` when the seller must repurchase. */
  status: 'written_off' | 'claim_open';
  daysPastDue: number;
}

/**
 * The desk stops waiting. The recourse term is the one the paper was priced with, not a choice made
 * after the loss — which is the whole reason it is stored on the price row and in the audit chain.
 *
 * Non-recourse is written off on the day it is declared. Recourse is only ever a claim: the seller's
 * promise to repurchase is not money, and this book does not post a recovery before it arrives.
 */
export function declareDefault(db: DatabaseSync, invoiceId: string, today = nowIso().slice(0, 10)): DefaultOutcome {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!invoice) throw new Error('invoice not found');
  if (invoice.status === 'disputed') throw new Error('this invoice is frozen by a dispute');
  if (invoice.status !== 'overdue') throw new Error(`only an overdue invoice can be declared in default; this one is ${invoice.status}`);
  const price = db.prepare('SELECT * FROM prices WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1').get(invoiceId) as any;
  if (!price) throw new Error('this invoice was never priced');

  const funders = db.prepare(
    "SELECT funder_id, SUM(principal_cents) AS cents FROM slices WHERE invoice_id = ? AND status = 'paid' AND funder_id IS NOT NULL GROUP BY funder_id"
  ).all(invoiceId) as any[];
  if (funders.length === 0) throw new Error('nothing was advanced against this invoice, so there is no position to close');

  const mode: RecourseTerm = price.recourse === 'non_recourse' ? 'non_recourse' : 'recourse';
  const funderOutlayCents = funders.reduce((n: number, f: any) => n + Number(f.cents), 0) as Cents;
  const claimCents = mode === 'recourse' ? funderOutlayCents : 0;

  for (const f of funders) {
    postDefault(db, invoiceId, f.funder_id, { funderOutlayCents: Number(f.cents), recourse: mode });
  }

  const daysPastDue = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_on}T00:00:00Z`)) / 86_400_000);
  const status = mode === 'recourse' ? 'claim_open' : 'written_off';
  db.prepare('INSERT INTO default_events (id, invoice_id, mode, face_cents, funder_outlay_cents, claim_cents, status, days_past_due, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(newId('dflt'), invoiceId, mode, Number(invoice.face_cents), funderOutlayCents, claimCents, status, Math.max(daysPastDue, 0), nowIso());
  db.prepare("UPDATE invoices SET status = 'defaulted' WHERE id = ?").run(invoiceId);
  appendAudit(db, 'default', invoiceId, { mode, funderOutlayCents, claimCents, status, daysPastDue, pricedRateBp: price.annual_rate_bp });

  return { mode, funderOutlayCents, claimCents, status, daysPastDue };
}

export interface RepurchaseOutcome {
  amountCents: Cents;
  shortfallCents: Cents;
  status: 'repurchased' | 'claim_open';
}

/** What the seller has already handed back to this funder, read from the book rather than trusted from memory. */
function repaidForFunder(db: DatabaseSync, invoiceId: string, funderId: string): number {
  return Number((db.prepare(
    `SELECT COALESCE(SUM(e.credit_cents), 0) AS n
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = ? AND e.txn_id LIKE 'repurchase:' || ? || ':%'`
  ).get(`funder:${funderId}:outlay`, invoiceId) as any).n);
}

/**
 * The seller meets the repurchase. The desk records what actually arrived and applies it; how the
 * money travelled — a PayPal payment, a wire, the next invoice paid short — is not this book's
 * business, but the amount is. Anything the seller leaves unpaid stays a live claim rather than being
 * quietly reclassified as recovered.
 */
export function collectRepurchase(db: DatabaseSync, invoiceId: string, amountCents: Cents): RepurchaseOutcome {
  const event = db.prepare('SELECT * FROM default_events WHERE invoice_id = ?').get(invoiceId) as any;
  if (!event) throw new Error('this invoice was never declared in default');
  if (event.mode !== 'recourse') throw new Error('a non-recourse position was written off on the day it defaulted; there is no claim to collect');
  if (event.status !== 'claim_open') throw new Error(`the claim on this invoice is already ${event.status}`);
  if (amountCents <= 0) throw new Error('a repurchase of zero is a refusal, not a payment');

  const funders = db.prepare(
    "SELECT funder_id, SUM(principal_cents) AS cents FROM slices WHERE invoice_id = ? AND status = 'paid' AND funder_id IS NOT NULL GROUP BY funder_id"
  ).all(invoiceId) as any[];
  // What is still owed, not what was ever owed: a second repurchase is measured against the claim
  // the first one left standing, so two partials can add up to the whole and cannot overlap.
  const outstanding = Number(event.claim_cents);
  if (amountCents > outstanding) {
    throw new Error(`the claim is ${outstanding} cents; a repurchase of ${amountCents} would overpay the funder`);
  }

  // Pay the funders back in the order they came in, each against its own unpaid remainder, so a
  // partial repurchase still balances per funder and no cent is applied twice.
  let remaining = amountCents;
  for (const f of funders) {
    if (remaining <= 0) break;
    const stillOwed = Number(f.cents) - repaidForFunder(db, invoiceId, f.funder_id);
    const take = Math.min(stillOwed, remaining);
    if (take <= 0) continue;
    postRepurchase(db, invoiceId, f.funder_id, take);
    remaining -= take;
  }
  const status = amountCents >= outstanding ? 'repurchased' : 'claim_open';
  db.prepare('UPDATE default_events SET status = ?, claim_cents = ? WHERE invoice_id = ?')
    .run(status, Math.max(outstanding - amountCents, 0), invoiceId);
  if (status === 'repurchased') db.prepare("UPDATE invoices SET status = 'repurchased' WHERE id = ?").run(invoiceId);
  appendAudit(db, 'repurchase', invoiceId, { amountCents, outstandingBeforeCents: outstanding, outstandingCents: Math.max(outstanding - amountCents, 0), status });
  return { amountCents, shortfallCents: Math.max(outstanding - amountCents, 0), status };
}

/** The seller will not or cannot pay. Only now does the recourse paper look like the non-recourse kind. */
export function writeOffClaim(db: DatabaseSync, invoiceId: string): { amountCents: Cents } {
  const event = db.prepare('SELECT * FROM default_events WHERE invoice_id = ?').get(invoiceId) as any;
  if (!event) throw new Error('this invoice was never declared in default');
  if (event.status !== 'claim_open') throw new Error(`the claim on this invoice is already ${event.status}`);
  const funders = db.prepare(
    "SELECT funder_id, SUM(principal_cents) AS cents FROM slices WHERE invoice_id = ? AND status = 'paid' AND funder_id IS NOT NULL GROUP BY funder_id"
  ).all(invoiceId) as any[];
  let amountCents = 0;
  for (const f of funders) {
    // Only what the seller never paid. A claim collected in part and then abandoned is written off
    // for the remainder, not for the whole advance a second time.
    const stillOwed = Number(f.cents) - repaidForFunder(db, invoiceId, f.funder_id);
    if (stillOwed <= 0) continue;
    postClaimWriteOff(db, invoiceId, f.funder_id, stillOwed);
    amountCents += stillOwed;
  }
  db.prepare("UPDATE default_events SET status = 'uncollectible', claim_cents = 0 WHERE invoice_id = ?").run(invoiceId);
  appendAudit(db, 'claim_write_off', invoiceId, { amountCents, mode: event.mode });
  return { amountCents };
}

// ---- Inbound webhooks -------------------------------------------------------

export interface WebhookResolution {
  invoiceId: string;
  /** Which field carried the link — stored as evidence that the match was not a guess. */
  via: string;
}

/**
 * A PayPal event names our invoice in one of several places, depending on its type. Every path
 * below is a lookup in our own tables: nothing is inferred from amounts or names, because a
 * freeze posted to the wrong invoice is worse than a freeze that never happened.
 */
export function resolveWebhookInvoice(db: DatabaseSync, event: any): WebhookResolution | null {
  const resource = event?.resource ?? {};
  const invoiceExists = (id: unknown): id is string => typeof id === 'string' && !!db.prepare('SELECT id FROM invoices WHERE id = ?').get(id);

  for (const field of ['custom_id', 'custom']) {
    if (invoiceExists(resource[field])) return { invoiceId: resource[field], via: `resource.${field}` };
  }

  const links: any[] = Array.isArray(resource?.links) ? resource.links : [];
  const orderId: unknown = resource?.supplementary_data?.related_ids?.order_id
    ?? links.map((l) => /\/(?:orders|checkout\/orders)\/([A-Z0-9]+)/.exec(String(l?.href ?? ''))?.[1]).find(Boolean);
  if (typeof orderId === 'string') {
    const maturity = db.prepare('SELECT invoice_id FROM maturity_orders WHERE paypal_order_id = ?').get(orderId) as any;
    if (maturity) return { invoiceId: maturity.invoice_id, via: 'related order (maturity)' };
    const commitment = db.prepare(
      'SELECT s.invoice_id AS invoice_id FROM commitments c JOIN slices s ON s.id = c.slice_id WHERE c.paypal_order_id = ?'
    ).get(orderId) as any;
    if (commitment) return { invoiceId: commitment.invoice_id, via: 'related order (funding)' };
  }

  const captureIds = new Set<string>();
  const disputed: any[] = Array.isArray(resource?.disputed_transactions) ? resource.disputed_transactions : [];
  for (const tx of disputed) {
    if (typeof tx?.seller_transaction_id === 'string') captureIds.add(tx.seller_transaction_id);
  }
  // A refund is delivered as the refund resource, which reaches its capture through `links`.
  if (typeof resource?.id === 'string') captureIds.add(resource.id);
  for (const link of links) {
    const found = /\/(?:captures|payments\/captures)\/([A-Z0-9]+)/.exec(String(link?.href ?? ''))?.[1];
    if (found) captureIds.add(found);
  }
  for (const captureId of captureIds) {
    const row = db.prepare(
      "SELECT s.invoice_id AS invoice_id FROM commitments c JOIN slices s ON s.id = c.slice_id WHERE ',' || c.capture_id || ',' LIKE ?"
    ).get(`%,${captureId},%`) as any;
    if (row) return { invoiceId: row.invoice_id, via: `capture ${captureId}` };
    const settled = db.prepare(
      "SELECT invoice_id FROM maturity_orders WHERE captures_json LIKE ? AND status = 'captured'"
    ).get(`%${captureId}%`) as any;
    if (settled) return { invoiceId: settled.invoice_id, via: `settlement capture ${captureId}` };
  }
  return null;
}

export interface FreezeResult {
  invoiceId: string;
  previousStatus: string;
  frozen: boolean;
}

/** Freezes a live position. A settled or refused invoice has nothing left to freeze. */
export function freezeForDispute(db: DatabaseSync, invoiceId: string, detail: Record<string, unknown>): FreezeResult {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!invoice) throw new Error(`no invoice ${invoiceId}`);
  const previousStatus = String(invoice.status);
  const freezable = ['verified', 'priced', 'listed', 'partially_funded', 'funded', 'matured'];
  const frozen = freezable.includes(previousStatus);
  if (frozen) {
    db.prepare("UPDATE invoices SET status = 'disputed' WHERE id = ?").run(invoiceId);
    appendAudit(db, 'dispute_freeze', invoiceId, { from: previousStatus, ...detail });
  } else if (previousStatus === 'disputed' && isClawback(detail)) {
    // Already frozen by a dispute, and now the money itself has moved back. The status does not
    // change, but the book records it, because a later "resolved" event must not unfreeze a position
    // that has already been paid out of.
    appendAudit(db, 'dispute_freeze', invoiceId, { from: previousStatus, ...detail, recordedOnly: true });
  }
  return { invoiceId, previousStatus, frozen };
}

function isClawback(detail: Record<string, unknown>): boolean {
  return /REFUNDED|REVERSED/.test(String(detail?.kind ?? ''));
}

/**
 * Reverses a freeze once PayPal resolves the case. The status to restore is the one the invoice
 * held when it froze, read back from the audit chain rather than guessed.
 *
 * One freeze does not release. A dispute about the goods can end with the seller keeping the money,
 * and then the position goes back where it was; a refund or a reversal *is* the money leaving, and a
 * later "resolved" event does not put it back. Restoring a clawed-back capture to `matured` would put
 * the book out of step with the bank, so the freeze holds and the loss is closed by the declared
 * default verbs, which is the only path in this build that moves money on paper like this.
 */
export function releaseFreeze(
  db: DatabaseSync,
  invoiceId: string,
  detail: Record<string, unknown>
): { invoiceId: string; restoredTo: string | null; heldForClawback: boolean } {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!invoice) throw new Error(`no invoice ${invoiceId}`);
  if (invoice.status !== 'disputed') return { invoiceId, restoredTo: null, heldForClawback: false };
  const last = db.prepare(
    "SELECT payload_json FROM audit_log WHERE kind = 'dispute_freeze' AND subject_id = ? ORDER BY seq DESC LIMIT 1"
  ).get(invoiceId) as any;
  let from: string | null = null;
  let frozeOn: string | null = null;
  try {
    const payload = last ? JSON.parse(last.payload_json) : null;
    from = payload?.from ?? null;
    frozeOn = String(payload?.kind ?? '');
  } catch { from = null; }
  if (/REFUNDED|REVERSED/.test(frozeOn ?? '')) {
    appendAudit(db, 'dispute_release_held', invoiceId, { because: frozeOn, ...detail });
    return { invoiceId, restoredTo: null, heldForClawback: true };
  }
  const restoredTo = from && from !== 'disputed' ? from : 'funded';
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(restoredTo, invoiceId);
  appendAudit(db, 'dispute_release', invoiceId, { to: restoredTo, ...detail });
  return { invoiceId, restoredTo, heldForClawback: false };
}
