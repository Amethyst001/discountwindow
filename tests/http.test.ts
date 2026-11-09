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

const DOC_REFUSED = 'UPS PROOF OF DELIVERY\nTracking number: 1Z999AA10123456738\nStatus: DELIVERED\nConsignee: Meridian Trade Ltd\nDelivered on: 2026-09-22 at 10:05\nShip to: 4400 Congress Ave, Austin TX 78701\nCustomer PO: PO-88421\nSigned by: R. OKAFOR';
const DOC_CORRECTED = 'UPS PROOF OF DELIVERY\nTracking number: 1Z999AA10123456754\nStatus: DELIVERED\nConsignee: Halcyon Retail Group\nDelivered on: 2026-09-22 at 11:40\nShip to: 4400 Congress Ave, Austin TX 78701\nCustomer PO: PO-88421\nSigned by: R. OKAFOR';

/** One priced invoice, one funded invoice with a notice and a service entry, and one refused invoice, written before boot. */
function seedBook(): { pricedId: string; fundedId: string; refusedId: string } {
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
  // A refusal the seller can answer: the parcel is real but the consignee is not the debtor.
  const refused = intakeInvoice(db, {
    ...base,
    invoice: { ...base.invoice, invoiceNumber: 'H-3' },
    pod: { ...POD, trackingNumber: '1Z999AA10123456738', consigneeName: 'Meridian Trade Ltd', deliveredOn: '2026-09-22' },
    evidenceSha256: sha(DOC_REFUSED),
    evidenceText: DOC_REFUSED,
    protection: { status: 'ELIGIBLE' as const, trackerId: '1Z999AA10123456738' }
  } as CreateInvoiceInput);
  db.prepare("INSERT INTO funders (id, legal_name, paypal_email, created_at) VALUES ('f1','Firstlight','funder@example.com',?)")
    .run(nowIso());
  // The desk's declared record with this debtor, as a real book would carry it: without this row the
  // resubmission is scored against an empty record and lands in band D, refused before its document
  // ever gets to speak.
  db.prepare("INSERT INTO debtor_history (debtor_id, invoices_due, paid_on_time, days_late_average, months_active, disputes) VALUES ('d1', 24, 16, 4.2, 18, 0)")
    .run();
  db.prepare("UPDATE invoices SET status = 'funded' WHERE id = ?").run(funded.invoiceId);
  db.prepare("INSERT INTO slices (id, invoice_id, funder_id, share_bp, principal_cents, status, created_at) VALUES ('sl1',?,'f1',10000,3642801,'paid',?)")
    .run(funded.invoiceId, nowIso());
  issueAssignmentNotice(db, funded.invoiceId);
  recordNoticeService(db, funded.invoiceId, { channel: 'Recorded delivery, UK', reference: 'TW059301341GB', enteredBy: 'desk' });
  db.close();
  return { pricedId: priced.invoiceId, fundedId: funded.invoiceId, refusedId: refused.invoiceId };
}

const book = seedBook();

async function boot(opts: { offline?: boolean; publicRead?: boolean } = {}): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH, EVIDENCE_DIR, PORT: String(PORT),
      DEMO_PASSWORD: SHARED, DEMO_PASSWORD_DESK: DESK,
      DEMO_PUBLIC_READ: opts.publicRead ? '1' : '',
      // The readers are optional and must not be reached from a test: no key, no network.
      EXTRACT_API_KEY: '', EXTRACT_B_API_KEY: '',
      // And the webhook id is deliberately empty, so a forged event fails its signature check
      // locally instead of asking PayPal to verify it over the network.
      PAYPAL_WEBHOOK_ID: '',
      // An empty string wins over the .env file (config reads process.env first), so `offline`
      // really is offline even on a machine that holds sandbox keys.
      ...(opts.offline
        ? {
            PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '',
            PAYPAL_SELLER_EMAIL: '', PAYPAL_PLATFORM_EMAIL: '', PAYPAL_FUNDER_EMAIL: ''
          }
        : {})
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
    // Brand icons ride with /health: browsers ask for them without credentials, and a 401 there
    // would flash a login prompt over a public demo. The allow-list decides what is served.
    const favicon = await get('/favicon.ico');
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type') ?? '', /^image\/x-icon/);
    assert.equal((await get('/favicon-32.png')).headers.get('content-type'), 'image/png');
    assert.equal((await get('/favicon-512.png')).status, 200);
    // A name outside the allow-list is not a door at all: it sits behind the login like everything else.
    assert.equal((await get('/favicon-999.png')).status, 401);
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
    assert.equal(list.invoices.length, 3);
    assert.equal(list.counts.total, 3);
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

test('a webhook that cannot be verified is answered 503 and stored nowhere, so PayPal retries instead of losing it', async () => {
  const stop = await boot();
  try {
    // The event is well-formed and names a real funded invoice through its custom_id. With no
    // webhook id configured, the signature check cannot run. That is not a definite "bad
    // signature"; it is "we could not ask". Storing it would make PayPal's retry look like a
    // duplicate, so the route must answer non-2xx and leave no row.
    const event = {
      id: 'WH-TEST-REPLAY-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'CAP-TEST-1', custom_id: book.fundedId, reason: 'forged refund' }
    };
    const post1 = await fetch(`${BASE}/webhooks/paypal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
    });
    assert.equal(post1.status, 503);
    assert.equal(await post1.text(), 'signature verification unavailable; retry');

    // Nothing was stored, and the position it names is untouched: no freeze, no status change.
    const after1 = JSON.parse(await (await get(`/api/invoices/${book.fundedId}`, `desk:${DESK}`)).text());
    assert.equal(after1.invoice.status, 'funded');
    const ledger = JSON.parse(await (await get('/api/ledger', `desk:${DESK}`)).text());
    assert.equal(ledger.recentWebhooks.filter((w: any) => w.type === 'PAYMENT.CAPTURE.REFUNDED').length, 0);

    // The replay is the same answer, and still no row: the retry has not been poisoned.
    const replay = await fetch(`${BASE}/webhooks/paypal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
    });
    assert.equal(replay.status, 503);
    const after2 = JSON.parse(await (await get(`/api/invoices/${book.fundedId}`, `desk:${DESK}`)).text());
    assert.equal(after2.invoice.status, 'funded');
  } finally {
    await stop();
  }
});

test('fix-my-refusal: a corrected document comes back as a new receivable, and the refusal stands', async () => {
  const stop = await boot();
  try {
    // The refused deal room carries the fix sentence from the rules — rules as data — and, for a
    // name holding the submit verb, the resubmission door.
    const refusedPage = await (await get(`/invoices/${book.refusedId}`, `desk:${DESK}`)).text();
    assert.match(refusedPage, /What the seller can do/);
    assert.match(refusedPage, /name on the delivery must be the debtor/);
    assert.match(refusedPage, new RegExp(`action="/invoices/${book.refusedId}/resubmit"`));
    // A funder reads the sentence — it is information — but is not shown the door, and pressing the
    // route anyway answers 403.
    const asFunder = await (await get(`/invoices/${book.refusedId}`, `funder:${SHARED}`)).text();
    assert.match(asFunder, /What the seller can do/);
    assert.doesNotMatch(asFunder, /resubmit/);
    assert.equal((await post(`/invoices/${book.refusedId}/resubmit`, `funder:${SHARED}`)).status, 403);

    // The corrected document: same trade, fixed consignee, a different file — a new hash.
    const submit = (doc: string) => {
      const form = new FormData();
      form.append('evidence', new Blob([doc], { type: 'text/plain' }), 'pod.txt');
      return fetch(`${BASE}/invoices/${book.refusedId}/resubmit`, {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Basic ${Buffer.from(`seller:${SHARED}`, 'utf8').toString('base64')}` },
        body: form
      });
    };
    const resub = await submit(DOC_CORRECTED);
    assert.equal(resub.status, 303);
    const newId = (resub.headers.get('location') ?? '').split('/').pop() ?? '';
    assert.match(newId, /^inv_/, 'the resubmission lands on its own deal room');
    const newPage = await (await get(`/invoices/${newId}`, `desk:${DESK}`)).text();
    assert.match(newPage, /Corrected submission of/);
    assert.doesNotMatch(newPage, /<h2>Refused<\/h2>/, 'the corrected document passes the same eleven checks');
    // The refused original is not rewritten: it still says refused, and it names its correction.
    const oldPage = await (await get(`/invoices/${book.refusedId}`, `desk:${DESK}`)).text();
    assert.match(oldPage, /<h2>Refused<\/h2>/);
    assert.match(oldPage, /A corrected submission exists/);

    // And the same document cannot come back: the refused evidence itself, offered again, is a new
    // receivable refused for reuse — with the fix sentence that says why.
    const reused = await submit(DOC_REFUSED);
    assert.equal(reused.status, 303);
    const reusedId = (reused.headers.get('location') ?? '').split('/').pop() ?? '';
    const reusedPage = await (await get(`/invoices/${reusedId}`, `desk:${DESK}`)).text();
    assert.match(reusedPage, /EVIDENCE_REUSED/);
    assert.match(reusedPage, /One delivery, one advance/);
  } finally {
    await stop();
  }
});

test('with no sandbox keys a fund press is answered 503 before any order exists, and says nothing was sent', async () => {
  const stop = await boot({ offline: true });
  try {
    const before = JSON.parse(await (await get(`/api/invoices/${book.pricedId}`, `desk:${DESK}`)).text());
    const res = await post(`/invoices/${book.pricedId}/fund`, `funder:${SHARED}`);
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.match(body, /Sandbox keys are needed for this step/);
    assert.match(body, /Nothing was sent to PayPal/);
    // No slice, no commitment, no order row: the refusal happened before the book was touched.
    const after = JSON.parse(await (await get(`/api/invoices/${book.pricedId}`, `desk:${DESK}`)).text());
    assert.equal(after.invoice.status, before.invoice.status);
    assert.equal((after.slices ?? []).length, (before.slices ?? []).length);
  } finally {
    await stop();
  }
});


test('DEMO_PUBLIC_READ lets a guest read the book and the deal rooms, and press nothing', async () => {
  const stop = await boot({ offline: true, publicRead: true });
  try {
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Read-only guest/);
    const room = await (await get(`/invoices/${book.pricedId}?view=funder`)).text();
    assert.match(room, /Read-only guest/);
    assert.doesNotMatch(room, /action="\/invoices\/[A-Za-z0-9_]+\/fund"/, 'no fund form for a guest');
    assert.match(room, /sign in<\/a> to press it/);
    const refused = await (await get(`/invoices/${book.refusedId}`)).text();
    assert.doesNotMatch(refused, /action="\/invoices\/[A-Za-z0-9_]+\/resubmit"/, 'no upload form for a guest');
    assert.equal((await get('/archive')).status, 200);
    assert.equal((await get('/ledger')).status, 200);
    // Everything that writes, uploads or reads the machine surface stays behind the password.
    assert.equal((await get('/submit')).status, 401);
    assert.equal((await get('/api/invoices')).status, 401);
    assert.equal((await get('/notices/register.csv')).status, 401);
    assert.equal((await get('/login')).status, 401, '/login raises the password prompt');
    assert.equal((await fetch(`${BASE}/invoices/${book.pricedId}/fund`, { method: 'POST' })).status, 401);
    // Credentials that are offered are still checked: a wrong password is not quietly a guest.
    assert.equal((await get('/', 'funder:wrong')).status, 401);
    const signedIn = await get('/login', `funder:${SHARED}`);
    assert.equal(signedIn.status, 200, 'after sign-in /login lands back on the book');
  } finally {
    await stop();
  }
});
