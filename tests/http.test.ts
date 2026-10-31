// The HTTP surface, over real sockets: what a session is allowed to read, and what it is allowed to
// make happen. The unit tests prove the render functions; this proves the routes in front of them,
// including the two things a judge can only find by clicking — a 403 with a name on it, and the desk's
// register refusing to download for anybody else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, nowIso } from '../src/db.ts';
import { intakeInvoice, type CreateInvoiceInput } from '../src/store.ts';
import { issueAssignmentNotice, recordNoticeService } from '../src/notice.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const SHARED = 'the-shared-demo-secret';
const DESK = 'only-the-desk-knows';
const PORT = 4317;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(ROOT, 'temp', 'http-surface.sqlite');
const EVIDENCE_DIR = path.join(ROOT, 'temp', 'http-surface-evidence');

const POD = {
  present: true, readable: true, carrier: 'UPS', trackingNumber: '1Z999AA10123456999',
  delivered: true, deliveredOn: '2026-09-20', consigneeName: 'Halcyon Retail Group',
  deliveryAddress: { line1: '4400 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
  hasSignature: true, hasPhoto: false, poRef: 'PO-88421',
  confidence: { trackingNumber: 0.97, consigneeName: 0.95, deliveredOn: 0.93, deliveryAddress: 0.91 }
};

/** One priced invoice, one funded invoice with a notice and a service entry, written before boot. */
function seedBook(): { pricedId: string; fundedId: string } {
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  const db = openDb(DB_PATH);
  const DOC = 'UPS PROOF OF DELIVERY\nTracking number: 1Z999AA10123456999\nStatus: DELIVERED\nConsignee: Halcyon Retail Group\nDelivered on: 2026-09-20 at 14:32\nShip to: 4400 Congress Ave, Austin TX 78701\nCustomer PO: PO-88421\nSigned by: R. OKAFOR';
  const base = {
    seller: { id: 's1', name: 'Northwind Components LLC', country: 'US' },
    debtor: {
      id: 'd1', name: 'Halcyon Retail Group',
      billingAddress: { line1: '4400 Congress Avenue', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
      limitCents: 30_000_000
    },
    invoice: {
      invoiceNumber: 'H-1', totalCents: 4_800_000, issuedOn: '2026-09-24', dueOn: '2026-11-23',
      poRef: 'PO-88421', lineItems: [{ description: 'goods', cents: 4_800_000 }]
    },
    pod: POD,
    evidenceSha256: sha(DOC),
    evidenceText: DOC,
    protection: { status: 'ELIGIBLE' as const, trackerId: POD.trackingNumber },
    history: {
      invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6_000_000,
      limitCents: 30_000_000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4_800_000
    },
    sandbox: false, allowProtectionOverride: false
  } as unknown as CreateInvoiceInput;
  const priced = intakeInvoice(db, base);
  const funded = intakeInvoice(db, {
    ...base,
    invoice: { ...base.invoice, invoiceNumber: 'H-2' },
    pod: { ...POD, trackingNumber: '1Z999AA10123456721' },
    evidenceSha256: sha('a second document'),
    evidenceText: 'UPS PROOF OF DELIVERY\nTracking number: 1Z999AA10123456721\nStatus: DELIVERED\nConsignee: Halcyon Retail Group\nDelivered on: 2026-09-21 at 09:15\nShip to: 4400 Congress Ave, Austin TX 78701\nCustomer PO: PO-88421\nSigned by: R. OKAFOR',
    protection: { status: 'ELIGIBLE' as const, trackerId: '1Z999AA10123456721' }
  } as CreateInvoiceInput);
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Firstlight','funder@example.com',?)")
    .run(nowIso());
  db.prepare("UPDATE invoices SET status = 'funded' WHERE id = ?").run(funded.invoiceId);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl1',?,'f1',10000,3642801,'paid',?)")
    .run(funded.invoiceId, nowIso());
  issueAssignmentNotice(db, funded.invoiceId);
  recordNoticeService(db, funded.invoiceId, { channel: 'Recorded delivery, UK', reference: 'TW059301341GB', enteredBy: 'desk' });
  db.close();
  return { pricedId: priced.invoiceId, fundedId: funded.invoiceId };
}

const book = seedBook();

async function boot(): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH, EVIDENCE_DIR, PORT: String(PORT),
      DEMO_PASSWORD: SHARED, DEMO_PASSWORD_DESK: DESK,
      // The readers are optional and must not be reached from a test: no key, no network.
      EXTRACT_API_KEY: '', EXTRACT_B_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise<never>((_, reject) => child.on('exit', (code) => reject(new Error(`server exited ${code}`))));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) { child.kill(); throw new Error('the server did not answer /health within 20s'); }
    try {
      const probe = await Promise.race([fetch(`${BASE}/health`), exited]);
      if (probe.status === 200) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return async () => { child.kill(); await new Promise((r) => setTimeout(r, 150)); };
}

const get = (p: string, who?: string) =>
  fetch(`${BASE}${p}`, who ? { headers: { authorization: `Basic ${Buffer.from(who, 'utf8').toString('base64')}` } } : {});
const post = (p: string, who: string) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(who, 'utf8').toString('base64')}` } });

test('the routes enforce the login, the name and the verb — over HTTP, not in a function', async () => {
  const stop = await boot();
  try {
    // /health is the one open door, so a container can check itself; everything else answers 401.
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/')).status, 401);
    // A username that is not one of the four is refused rather than quietly given the desk.
    assert.equal((await get('/', `judge:${SHARED}`)).status, 401);
    // A side holding its own secret stops accepting the shared one: the desk is not a password away
    // for whoever was handed the link.
    assert.equal((await get('/', `desk:${SHARED}`)).status, 401);
    assert.equal((await get('/', `desk:${DESK}`)).status, 200);
    assert.equal((await get('/', `seller:${SHARED}`)).status, 200);
    assert.equal((await get('/', `funder:${SHARED}`)).status, 200);

    // The lens opens to the seller; the button does not.
    const asSeller = await (await get(`/invoices/${book.pricedId}?view=desk`, `seller:${SHARED}`)).text();
    assert.match(asSeller, /Signed in as <strong>seller<\/strong>/);
    assert.doesNotMatch(asSeller, new RegExp(`action="/invoices/${book.pricedId}/fund"`));
    assert.match(asSeller, /Fund is pressed by <strong>desk<\/strong> or <strong>funder<\/strong>/);
    const asFunder = await (await get(`/invoices/${book.pricedId}?view=desk`, `funder:${SHARED}`)).text();
    assert.match(asFunder, new RegExp(`action="/invoices/${book.pricedId}/fund"`), 'the funder holds the verb the lens offers');

    // Uploading is a door, not a view: the link is not offered to a name that cannot walk through it,
    // and walking to it anyway gets the sentence instead of a form with a 403 on the other side.
    assert.match(asSeller, /href="\/submit"/, 'a seller may upload, so the way in is on the page');
    assert.doesNotMatch(asFunder, /href="\/submit"/, 'a funder is not shown the door to a verb it lacks');
    const submitAsFunder = await get('/submit', `funder:${SHARED}`);
    assert.equal(submitAsFunder.status, 403);
    assert.match(await submitAsFunder.text(), /which may not submit an invoice/);
    assert.equal((await get('/submit', `seller:${SHARED}`)).status, 200);

    // Reading as the other side never turns into writing as them.
    assert.equal((await post(`/invoices/${book.pricedId}/fund`, `seller:${SHARED}`)).status, 403);
    const forbidden = await (await post(`/invoices/${book.pricedId}/fund`, `seller:${SHARED}`)).text();
    assert.match(forbidden, /seller<\/strong> is signed in as seller, which may not fund an invoice/);

    // The register: one file, whole book, desk name only.
    const refused = await get('/notices/register.csv', `seller:${SHARED}`);
    assert.equal(refused.status, 403);
    const file = await get('/notices/register.csv', `desk:${DESK}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="notice-service-register-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = await file.text();
    assert.ok(csv.startsWith('"served_on","invoice_number","debtor",'), 'the header arrives on the first bytes');
    assert.match(csv, /"Recorded delivery, UK","TW059301341GB","desk"/);
    assert.match(csv, /"yes"\r\n$/, 'the stored digest still matches the bytes on disk');

    // And the desk's notebook stays off the page for a name that is not the desk, in any lens.
    const fundedAsSeller = await (await get(`/invoices/${book.fundedId}?view=desk`, `seller:${SHARED}`)).text();
    assert.match(fundedAsSeller, /Notice of assignment/);
    assert.doesNotMatch(fundedAsSeller, /Service register/);
    assert.doesNotMatch(fundedAsSeller, /register\.csv/);
    const fundedAsDesk = await (await get(`/invoices/${book.fundedId}?view=desk`, `desk:${DESK}`)).text();
    assert.match(fundedAsDesk, /Service register/);
    assert.match(fundedAsDesk, /TW059301341GB/);
    // The audit chain still walks after all of that, which is the check that nothing above wrote.
    assert.equal((await get('/ledger', `desk:${DESK}`)).status, 200);
  } finally {
    await stop();
  }
});

test('the machine surface: a public status page, a desk-only JSON API, and a webhook that reaches its signature check', async () => {
  const stop = await boot();
  try {
    // /status is public on purpose: a judge with no credentials gets to watch the book prove
    // itself — the chain re-walked, the counts, the balance assertion.
    const status = await get('/status');
    assert.equal(status.status, 200);
    assert.match(await status.text(), /audit chain/i);
    assert.equal((await get('/api/status')).status, 200);

    // The API is the desk's. No login is a 401; a wrong role is a JSON 403 that names the verb;
    // the desk gets JSON objects back.
    assert.equal((await get('/api/invoices')).status, 401);
    const sellerApi = await get('/api/invoices', `seller:${SHARED}`);
    assert.equal(sellerApi.status, 403);
    assert.match(await sellerApi.text(), /may not read the api/);
    const listRes = await get('/api/invoices', `desk:${DESK}`);
    assert.equal(listRes.status, 200);
    assert.match(listRes.headers.get('content-type') ?? '', /application\/json/);
    const list = JSON.parse(await listRes.text());
    assert.equal(Array.isArray(list.invoices), true);
    assert.equal(list.invoices.length, 2);
    assert.equal(list.counts.total, 2);
    const detail = JSON.parse(await (await get(`/api/invoices/${book.pricedId}`, `desk:${DESK}`)).text());
    assert.ok(JSON.stringify(detail).includes('H-1'), 'the deal room object carries the invoice');
    assert.equal((await get('/api/invoices/NOPE', `desk:${DESK}`)).status, 404);
    const ledger = JSON.parse(await (await get('/api/ledger', `desk:${DESK}`)).text());
    assert.ok(Array.isArray(ledger.rows), 'the ledger arrives as its rows');
    assert.ok(Array.isArray(ledger.totals), 'the totals arrive beside them');

    // PayPal delivers webhooks without basic auth: a malformed body reaches the handler and its
    // json check (400) instead of the 401 wall. The same path with GET is still closed.
    const hook = await fetch(`${BASE}/webhooks/paypal`, { method: 'POST', body: 'not json' });
    assert.equal(hook.status, 400);
    assert.equal((await get('/webhooks/paypal')).status, 401);
  } finally {
    await stop();
  }
});
