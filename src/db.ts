import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  paypal_merchant_id TEXT,
  legal_name TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debtors (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  billing_address_json TEXT NOT NULL,
  limit_cents INTEGER NOT NULL CHECK (limit_cents >= 0),
  created_at TEXT NOT NULL
);

-- The desk's record with a debtor before this system existed. The scorecard reads this plus what
-- has actually settled on the platform; it never reads a bureau.
CREATE TABLE IF NOT EXISTS debtor_history (
  debtor_id TEXT PRIMARY KEY REFERENCES debtors(id),
  invoices_due INTEGER NOT NULL DEFAULT 0,
  paid_on_time INTEGER NOT NULL DEFAULT 0,
  days_late_average REAL NOT NULL DEFAULT 0,
  months_active INTEGER NOT NULL DEFAULT 0,
  disputes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  debtor_id TEXT NOT NULL REFERENCES debtors(id),
  invoice_number TEXT NOT NULL,
  face_cents INTEGER NOT NULL CHECK (face_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  po_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (debtor_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS evidence_files (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  tracker TEXT,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence_files(id),
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  confidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  check_id TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  detail TEXT NOT NULL,
  rule TEXT,
  evidence_region TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checks_invoice ON checks(invoice_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  kind TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  debtor_id TEXT NOT NULL REFERENCES debtors(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  components_json TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  band TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  annual_rate_bp INTEGER NOT NULL,
  tenor_days INTEGER NOT NULL,
  fee_reserve_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  advance_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  recourse TEXT NOT NULL DEFAULT 'recourse',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funders (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  paypal_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  funder_id TEXT REFERENCES funders(id),
  share_bp INTEGER NOT NULL CHECK (share_bp > 0 AND share_bp <= 10000),
  principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  slice_id TEXT NOT NULL REFERENCES slices(id),
  paypal_order_id TEXT NOT NULL UNIQUE,
  capture_id TEXT,
  capture_status TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  approve_link TEXT,
  created_at TEXT NOT NULL
);

-- The debtor's payment at maturity: one order whose purchase units are the funder's gross slice
-- and the seller's remainder, so the face value reaches both payees in one capture.
CREATE TABLE IF NOT EXISTS maturity_orders (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
  paypal_order_id TEXT NOT NULL,
  approve_link TEXT,
  funder_id TEXT NOT NULL,
  gross_funder_cents INTEGER NOT NULL,
  gross_seller_cents INTEGER NOT NULL,
  captures_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A receivable that the debtor never pays still has to end up somewhere, and the two endings are
-- different trades. recourse means the seller repurchases the paper; non_recourse means the
-- underwriting was the desk's own and the funder absorbs the outlay. Recorded as an event, never
-- inferred, because the ledger posting depends on which one it is.
CREATE TABLE IF NOT EXISTS default_events (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
  mode TEXT NOT NULL CHECK (mode IN ('recourse', 'non_recourse')),
  face_cents INTEGER NOT NULL CHECK (face_cents > 0),
  funder_outlay_cents INTEGER NOT NULL CHECK (funder_outlay_cents > 0),
  claim_cents INTEGER NOT NULL DEFAULT 0 CHECK (claim_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('written_off', 'claim_open', 'repurchased', 'uncollectible')),
  days_past_due INTEGER NOT NULL CHECK (days_past_due >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
  sha256 TEXT NOT NULL,
  body_text TEXT NOT NULL,
  addressee TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- What the desk wrote down about sending the notice. A reference entered by an operator is stored as
-- an operator's statement, never as a carrier's: this table has no third party in it, so its honest
-- claim is "the desk says it served this, on this day, by this channel, with these bytes".
CREATE TABLE IF NOT EXISTS notice_service (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL REFERENCES notices(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  channel TEXT NOT NULL,
  reference TEXT,
  reference_entered_by TEXT NOT NULL,
  digest TEXT NOT NULL,
  served_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notice_service_invoice ON notice_service(invoice_id);

-- The register is read in the order the notices went out, and a file of every attempt is the answer to
-- "show me what you served", which is a question about the whole book rather than one invoice.
CREATE INDEX IF NOT EXISTS idx_notice_service_served ON notice_service(served_at, created_at, id);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue', 'equity')),
  owner_ref TEXT
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);

CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);

-- Append-only: an entry can never be edited or removed. Corrections are new transactions.
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

-- A service register the operator can quietly amend proves nothing, so the same protection covers it.
CREATE TRIGGER IF NOT EXISTS notice_service_no_update
BEFORE UPDATE ON notice_service
BEGIN
  SELECT RAISE(ABORT, 'notice_service is append-only');
END;

CREATE TRIGGER IF NOT EXISTS notice_service_no_delete
BEFORE DELETE ON notice_service
BEGIN
  SELECT RAISE(ABORT, 'notice_service is append-only');
END;

CREATE VIEW IF NOT EXISTS v_unbalanced_txns AS
  SELECT txn_id, SUM(debit_cents) AS debits, SUM(credit_cents) AS credits
  FROM ledger_entries
  GROUP BY txn_id
  HAVING SUM(debit_cents) <> SUM(credit_cents);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  invoice_id TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(dbPath = config.dbPath): DatabaseSync {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // A database created before the webhook columns existed still has to open; SQLite has no
  // IF NOT EXISTS for ADD COLUMN, so ask the table what it already has.
  const columns = new Set((db.prepare('PRAGMA table_info(webhook_events)').all() as any[]).map((c) => c.name));
  for (const column of ['invoice_id', 'outcome']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE webhook_events ADD COLUMN ${column} TEXT`);
  }
  const commitmentColumns = new Set((db.prepare('PRAGMA table_info(commitments)').all() as any[]).map((c) => c.name));
  for (const column of ['approve_link', 'capture_status']) {
    if (!commitmentColumns.has(column)) db.exec(`ALTER TABLE commitments ADD COLUMN ${column} TEXT`);
  }
  const checkColumns = new Set((db.prepare('PRAGMA table_info(checks)').all() as any[]).map((c) => c.name));
  if (!checkColumns.has('rule')) db.exec('ALTER TABLE checks ADD COLUMN rule TEXT');
  const priceColumns = new Set((db.prepare('PRAGMA table_info(prices)').all() as any[]).map((c) => c.name));
  if (!priceColumns.has('recourse')) db.exec("ALTER TABLE prices ADD COLUMN recourse TEXT NOT NULL DEFAULT 'recourse'");
  const evidenceColumns = new Set((db.prepare('PRAGMA table_info(evidence_files)').all() as any[]).map((c) => c.name));
  if (!evidenceColumns.has('tracker')) db.exec('ALTER TABLE evidence_files ADD COLUMN tracker TEXT');
  // The index is made here rather than in SCHEMA: SCHEMA runs before the ALTER above, so an index on
  // a column a pre-existing database does not have yet would stop an upgraded book from opening at all.
  db.exec('CREATE INDEX IF NOT EXISTS evidence_tracker ON evidence_files (tracker)');
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
