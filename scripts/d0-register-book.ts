// HTTP check of the register export: a real server, a real Basic-auth identity, a real CSV download.
// Scratch database only — nothing here touches the demo book.
import fs from 'node:fs';
import { openDb, nowIso } from '../src/db.ts';
import { issueAssignmentNotice, recordNoticeService } from '../src/notice.ts';

const file = 'temp/register.sqlite';
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
const db = openDb(file);
const at = nowIso();
db.prepare("INSERT INTO sellers (id, paypal_merchant_id, legal_name, country, created_at) VALUES ('s1','seller@example.com','Northwind Components LLC','US',?)").run(at);
db.prepare('INSERT INTO debtors (id, legal_name, normalized_name, billing_address_json, limit_cents, created_at) VALUES (?,?,?,?,?,?)')
  .run('d1', 'Halcyon Industries', 'halcyon', JSON.stringify({ line1: '18 Rigging Rd', city: 'Austin', region: 'TX', postalCode: '78701', countryCode: 'US' }), 1_000_000, at);
db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Sandbox Funder','funder@example.com',?)").run(at);
db.prepare(`INSERT INTO invoices (id, invoice_number, seller_id, debtor_id, face_cents, currency, issued_on, due_on, status, created_at)
            VALUES ('inv_1','NW-1','s1','d1',65000,'USD','2026-10-01','2026-11-30','funded',?)`).run(at);
db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl_1','inv_1','f1',10000,49301,'paid',?)").run(at);

issueAssignmentNotice(db, 'inv_1', '2026-10-30');
recordNoticeService(db, 'inv_1', { channel: 'Recorded delivery, UK', reference: 'TW059301341GB', servedAt: '2026-10-30', enteredBy: 'desk' });
recordNoticeService(db, 'inv_1', { channel: 'Portal', reference: '=HYPERLINK("http://evil.example","click")', servedAt: '2026-11-01', enteredBy: 'desk' });
console.log('scratch book written with two service entries');
