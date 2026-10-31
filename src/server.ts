import http from 'node:http';
import fs from 'node:fs';
import nodePath from 'node:path';
import crypto from 'node:crypto';
import { config, isSandbox, assertSandbox } from './config.ts';
import { basicAuthIdentity, roleAllows, type Identity } from './auth.ts';
import { openDb, newId, nowIso } from './db.ts';
import { listInvoices, invoiceDetail, archiveSummary, archiveCounts, ledgerRows, ledgerTotals, createFundingOrder, captureFunding, createMaturityOrder, captureMaturity, addSlice, ensureParty, intakeInvoice, debtorHistory, resolveWebhookInvoice, freezeForDispute, releaseFreeze, markCaptureCompleted, sweepOverdue, declareDefault, collectRepurchase, writeOffClaim } from './store.ts';
import { storedNotice, recordNoticeService, noticeServiceCsv } from './notice.ts';
import { renderBook, renderDealRoom, renderLedger, renderArchive, renderSubmit, renderStatus, viewOf } from './pages.ts';
import { verifyChain, appendAudit } from './audit.ts';
import { verifyWebhookSignature, getOrder } from './paypal.ts';
import { extractEvidence } from './extract.ts';
import { parseMoneyToCents } from './money.ts';
import { esc } from './html.ts';

assertSandbox();
const db = openDb();
const ALLOW_OVERRIDE = process.env.DW_ALLOW_PROTECTION_OVERRIDE !== '0' && isSandbox();

// A container started against an empty volume would otherwise serve a blank desk. The seed is the
// demo data, so first start fills itself; DW_NO_AUTOSEED=1 opts out.
if (!process.env.DW_NO_AUTOSEED && Number(db.prepare('SELECT COUNT(*) AS n FROM invoices').get()?.n ?? 0) === 0) {
  console.log('empty database: seeding the demo book');
  await import('./seed.ts');
}

// A day turning over is a state change in this book. Funded paper whose due date and its own
// jurisdiction's grace period have passed becomes overdue when the desk opens it, because the grace
// period is a country setting and the only honest time to apply it is on read. Nothing goes to
// default on a timer: that is a decision, and it has a button on it.
const sweptAtBoot = sweepOverdue(db);
for (const s of sweptAtBoot) {
  console.log(`overdue: ${s.invoiceNumber} is ${s.daysPastDue} days past due on a ${s.graceDays}-day grace`);
}

function send(res: http.ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Part { filename?: string; mime: string; data: Buffer }

/** Minimal multipart/form-data reader: one file and a handful of text fields, nothing else. */
function parseMultipart(body: Buffer, boundary: string): Map<string, Part> {
  const out = new Map<string, Part>();
  const delimiter = Buffer.from(`--${boundary}`);
  let index = body.indexOf(delimiter);
  while (index >= 0) {
    const start = index + delimiter.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next < 0) break;
    const section = body.slice(start + 2, next - 2); // trim CRLF either side
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = section.slice(0, headerEnd).toString('utf8');
      const data = section.slice(headerEnd + 4);
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
      if (name) out.set(name, { filename: filename || undefined, mime, data });
    }
    index = next;
  }
  return out;
}

const ALLOWED_MIME = new Set(['application/pdf', 'text/plain', 'image/png', 'image/jpeg']);

function sniffMime(bytes: Buffer, declared: string): string | null {
  const head = bytes.slice(0, 8);
  if (head.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (ALLOWED_MIME.has(declared) && (declared === 'text/plain' || declared === 'application/pdf')) return declared;
  const printable = bytes.slice(0, 512).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
  return printable ? 'text/plain' : null;
}

function noticePage(title: string, message: string, back: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;padding:40px;background:#f4efe4;color:#191712;max-width:640px">
    <h1 style="font-family:Georgia,serif;font-weight:500">${esc(title)}</h1><p>${esc(message)}</p><p><a href="${esc(back)}">Back to the invoice</a></p>`;
}

/** Everything the status page and /api/status show, computed on request, aggregate only. */
function statusData(db: ReturnType<typeof openDb>) {
  return {
    sandbox: isSandbox(),
    generatedAt: nowIso(),
    auditChain: verifyChain(db),
    archiveCounts: archiveCounts(db),
    ledgerTotals: ledgerTotals(db),
    webhooksByType: db.prepare('SELECT type, COUNT(*) AS n, SUM(verified) AS verified FROM webhook_events GROUP BY type ORDER BY n DESC').all(),
    lastWebhookAt: (db.prepare('SELECT MAX(received_at) AS at FROM webhook_events').get() as any)?.at ?? null
  };
}

async function orderIsApproved(orderId: string): Promise<{ ok: boolean; status: string }> {
  const order = await getOrder(orderId).catch(() => null);
  const status = String(order?.status ?? 'UNKNOWN');
  return { ok: status === 'APPROVED' || status === 'COMPLETED', status };
}

function invoiceIsFrozen(db: ReturnType<typeof openDb>, invoiceId: string): boolean {
  const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceId) as any;
  return row?.status === 'disputed';
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const DEMO_IDENTITIES: Identity[] = [
  { role: 'desk', name: 'desk' },
  { role: 'seller', name: 'seller' },
  { role: 'funder', name: 'funder' },
  { role: 'debtor', name: 'debtor' }
];

function forbidden(identity: Identity, verb: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Not this account</title><body style="font-family:system-ui;padding:40px;background:#f4efe4;color:#191712;max-width:640px">
    <h1 style="font-family:Georgia,serif;font-weight:500">Not this account</h1>
    <p><strong>${esc(identity.name)}</strong> is signed in as ${esc(identity.role)}, which may not ${esc(verb)} an invoice. The four demo identities and what each may do are listed in the README.</p>
    <p><a href="/">Back to the book</a></p>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    // A public demo URL can create sandbox orders and captures, so it carries one shared password
    // and four named identities; the username decides what the session may do. Three doors stay
    // open without it: /health for the container check, the status page — which exists to be read
    // by somebody with no credentials at all — and PayPal's webhook POSTs. Those carry no basic
    // auth and need none: the handler refuses to act on anything whose signature does not verify,
    // so the route's authority is the signature, not the password. A GET on the webhook path is
    // still behind the wall.
    const webhookDelivery = req.method === 'POST' && path === '/webhooks/paypal';
    const openPath = path === '/health' || path === '/status' || path === '/api/status' || webhookDelivery;
    const auth = basicAuthIdentity(req.headers.authorization, config.demoPassword, config.demoPasswordsByRole);
    if (!auth.ok && !openPath) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="The Discount Window (desk | seller | funder | debtor)", charset="UTF-8"',
        'Content-Type': 'text/plain'
      });
      return res.end('Authentication required. Use one of the demo usernames: desk, seller, funder, debtor.');
    }
    const identity: Identity = auth.ok ? auth.identity : { role: 'desk', name: 'desk' };
    // The lens opens to whoever signs in; the authority stays with the username (see `deny` below).
    // A funder who cannot put on the seller's view cannot check what the seller was told, and a
    // reviewer should not have to log out to find out what the other side of the desk looks like.
    const ownLens = identity.role === 'seller' || identity.role === 'funder' ? identity.role : 'desk';
    const requested = url.searchParams.get('view');
    const view = viewOf(requested === 'desk' || requested === 'seller' || requested === 'funder' ? requested : ownLens);
    const deny = (verb: string): boolean => {
      if (roleAllows(identity.role, verb)) return false;
      send(res, 403, forbidden(identity, verb), 'text/html; charset=utf-8');
      return true;
    };
    if (req.method === 'GET' && path === '/') {
      const counts = archiveCounts(db);
      return send(res, 200, renderBook(listInvoices(db, { status: url.searchParams.get('status') ?? undefined }), counts, isSandbox(), view, identity));
    }
    if (req.method === 'GET' && path === '/submit') {
      // Uploading is a verb, so the form is a door and not a view: a debtor or a funder is told
      // whose button this is rather than handed a page whose only exit is a 403.
      if (deny('submit')) return;
      const dealers = db.prepare('SELECT id, legal_name, limit_cents FROM debtors ORDER BY legal_name LIMIT 60').all();
      return send(res, 200, renderSubmit(dealers as any[], isSandbox(), undefined, identity));
    }
    if (req.method === 'POST' && path === '/submit') {
      if (deny('submit')) return;
      const type = String(req.headers['content-type'] ?? '');
      const boundary = /boundary=(.+)$/.exec(type)?.[1]?.replace(/^"|"$/g, '');
      if (!boundary) return send(res, 400, 'expected multipart/form-data', 'text/plain');
      const form = parseMultipart(await readRaw(req, 12_000_000), boundary);
      const file = form.get('evidence');
      const field = (k: string) => form.get(k)?.data.toString('utf8').trim() ?? '';
      const fail = (message: string) => {
        const dealers = db.prepare('SELECT id, legal_name, limit_cents FROM debtors ORDER BY legal_name LIMIT 60').all();
        return send(res, 400, renderSubmit(dealers as any[], isSandbox(), message));
      };
      if (!file || file.data.length === 0) return fail('Attach the proof of delivery.');
      const mime = sniffMime(file.data, file.mime);
      if (!mime) return fail('That file is not a PDF, a text file, a PNG or a JPEG.');
      const face = parseMoneyToCents(field('face'));
      if (!face || face <= 0) return fail('The face value must be a positive amount in dollars.');
      const invoiceNumber = field('invoiceNumber');
      const debtorId = field('debtorId');
      const debtor = db.prepare('SELECT id, legal_name, billing_address_json, limit_cents FROM debtors WHERE id = ?').get(debtorId) as any;
      if (!debtor) return fail('Choose a debtor on file.');
      if (!invoiceNumber) return fail('The invoice number is required.');

      const sha = crypto.createHash('sha256').update(file.data).digest('hex');
      fs.mkdirSync(config.evidenceDir, { recursive: true });
      const stored = nodePath.join(config.evidenceDir, `${sha}${mime === 'application/pdf' ? '.pdf' : mime === 'text/plain' ? '.txt' : mime === 'image/png' ? '.png' : '.jpg'}`);
      if (!fs.existsSync(stored)) fs.writeFileSync(stored, file.data);

      const extraction = await extractEvidence(file.data, mime);
      const issuedOn = field('issuedOn');
      const dueOn = field('dueOn');
      const outcome = intakeInvoice(db, {
        seller: { id: 'seller-northwind', name: 'Northwind Components LLC', country: 'US', paypalMerchantId: config.sellerEmail || undefined },
        debtor: {
          id: debtor.id,
          name: debtor.legal_name,
          billingAddress: JSON.parse(debtor.billing_address_json),
          limitCents: Number(debtor.limit_cents)
        },
        invoice: {
          invoiceNumber,
          totalCents: face,
          issuedOn,
          dueOn,
          poRef: field('poRef') || extraction.invoiceHints.poRef || undefined,
          lineItems: [{ description: 'Goods as invoiced', cents: face }]
        },
        pod: extraction.pod,
        evidenceSha256: sha,
        evidenceText: extraction.text,
        evidence: {
          path: stored, mime, bytes: file.data.length,
          model: extraction.model, modelVersion: extraction.modelVersion,
          raw: extraction.raw, confidence: extraction.confidence, notes: extraction.notes
        },
        // A seller may only declare that the rail never saw the sale; `ELIGIBLE` is PayPal's answer to
        // ask, never a field on a form. Anything else stays UNKNOWN, which the sandbox records as an
        // override rather than a pass.
        protection: { status: field('railStatus') === 'NOT_ON_RAIL' ? 'NOT_ON_RAIL' : 'UNKNOWN' },
        recourse: field('recourse') === 'non_recourse' ? 'non_recourse' : 'recourse',
        history: debtorHistory(db, debtor.id, face),
        sandbox: isSandbox(),
        allowProtectionOverride: ALLOW_OVERRIDE
      });
      res.writeHead(303, { Location: `/invoices/${outcome.invoiceId}` });
      return res.end();
    }
    if (req.method === 'GET' && path === '/archive') {
      const recent = db.prepare(`
        SELECT i.id, i.invoice_number, i.face_cents, i.created_at, d.legal_name AS debtor_name,
               json_extract(a.payload_json, '$.refusals[0].code') AS reason
          FROM invoices i
          JOIN debtors d ON d.id = i.debtor_id
          JOIN audit_log a ON a.subject_id = i.id AND a.kind = 'gate'
         WHERE i.status = 'REFUSED'
         ORDER BY i.created_at DESC LIMIT 60`).all();
      return send(res, 200, renderArchive(archiveSummary(db), archiveCounts(db), recent as any[], isSandbox(), identity));
    }
    if (req.method === 'GET' && path === '/ledger') {
      const events = db.prepare('SELECT received_at, type, verified, outcome FROM webhook_events ORDER BY received_at DESC LIMIT 20').all();
      return send(res, 200, renderLedger(ledgerRows(db), ledgerTotals(db), isSandbox(), events as any[], identity));
    }
    // The status page: the desk's vitals for whoever asks, no login. Aggregate only — it names no
    // operator, no party and no document, which is what makes it safe to leave open.
    if (req.method === 'GET' && (path === '/status' || path === '/api/status')) {
      const data = statusData(db);
      if (path === '/api/status') return send(res, 200, JSON.stringify(data, null, 2), 'application/json');
      return send(res, 200, renderStatus(data));
    }
    // The machine surface: the same objects the desk's pages render, as JSON. Desk-only, because
    // these objects carry the desk's notebook — the service register, the raw extractions — and
    // the lens that hides those on the page is a render decision, not a data one. An agent reading
    // this surface signs in as the desk, exactly as a human operator does; a 403 here is JSON,
    // because the client is a program.
    if (req.method === 'GET' && path === '/api/invoices') {
      if (deny('read the api')) return;
      return send(res, 200, JSON.stringify({
        sandbox: isSandbox(),
        generatedAt: nowIso(),
        counts: archiveCounts(db),
        invoices: listInvoices(db, { status: url.searchParams.get('status') ?? undefined })
      }, null, 2), 'application/json');
    }
    const apiDetailMatch = /^\/api\/invoices\/([A-Za-z0-9_]+)$/.exec(path);
    if (req.method === 'GET' && apiDetailMatch) {
      if (deny('read the api')) return;
      const detail = invoiceDetail(db, apiDetailMatch[1]);
      if (!detail) return send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
      return send(res, 200, JSON.stringify(detail, null, 2), 'application/json');
    }
    if (req.method === 'GET' && path === '/api/ledger') {
      if (deny('read the api')) return;
      const events = db.prepare('SELECT received_at, type, verified, outcome FROM webhook_events ORDER BY received_at DESC LIMIT 20').all();
      return send(res, 200, JSON.stringify({ rows: ledgerRows(db), totals: ledgerTotals(db), recentWebhooks: events }, null, 2), 'application/json');
    }
    const detailMatch = /^\/invoices\/([A-Za-z0-9_]+)$/.exec(path);
    if (req.method === 'GET' && detailMatch) {
      const detail = invoiceDetail(db, detailMatch[1]);
      if (!detail) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, renderDealRoom(detail, isSandbox(), view, identity));
    }
    const noticeMatch = /^\/invoices\/([A-Za-z0-9_]+)\/notice$/.exec(path);
    if (req.method === 'GET' && noticeMatch) {
      const stored = storedNotice(db, noticeMatch[1]);
      if (!stored) return send(res, 404, 'No notice has been issued: this receivable has not been funded in full.', 'text/plain');
      const number = String((db.prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(noticeMatch[1]) as any)?.invoice_number ?? noticeMatch[1]);
      // The bytes served are the bytes stored, so anyone who downloads it can re-run the digest and
      // compare it with the hash in the audit chain. Adding a footer here would break that.
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="notice-of-assignment-${number}.txt"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(stored.body_text);
    }
    // The whole book's register as one file, for the conversation where someone asks to see every
    // notice the desk says it served. Desk-only: the entries name the debtor and the operator.
    if (req.method === 'GET' && path === '/notices/register.csv') {
      if (deny('export the register')) return;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="notice-service-register-${nowIso().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(noticeServiceCsv(db));
    }
    // The desk writing down that it sent the notice. The digest is taken from the stored bytes, never
    // from this form, so the entry certifies the text and not whatever the operator meant to send.
    const serviceMatch = /^\/invoices\/([A-Za-z0-9_]+)\/notice\/service$/.exec(path);
    if (req.method === 'POST' && serviceMatch) {
      if (deny('serve notice')) return;
      const id = serviceMatch[1];
      const form = new URLSearchParams(await readBody(req, 100_000));
      const channel = (form.get('channel') ?? '').trim().slice(0, 60);
      const reference = (form.get('reference') ?? '').trim().slice(0, 80);
      const servedAt = (form.get('servedAt') ?? '').trim().slice(0, 10);
      if (!channel) {
        return send(res, 400, noticePage('No channel', 'Say how it went out — the post, a courier, the debtor\'s own portal. A register of attempts needs to name the attempt.', `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      let entry: Awaited<ReturnType<typeof recordNoticeService>>;
      try {
        entry = recordNoticeService(db, id, { channel, reference: reference || null, servedAt: servedAt || undefined, enteredBy: identity.name });
      } catch (err: any) {
        return send(res, 409, noticePage('Cannot record service', String(err?.message ?? err), `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      if (!entry) {
        return send(res, 409, noticePage('Nothing to serve', 'No notice has been issued for this receivable: it has not been funded in full.', `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    const fundMatch = /^\/invoices\/([A-Za-z0-9_]+)\/fund$/.exec(path);
    if (req.method === 'POST' && fundMatch) {
      if (deny('fund')) return;
      const id = fundMatch[1];
      const detail = invoiceDetail(db, id);
      if (!detail) return send(res, 404, 'Not found', 'text/plain');
      if (detail.invoice.status === 'REFUSED') return send(res, 409, 'A refusal is terminal.', 'text/plain');
      if (detail.invoice.status === 'disputed') return send(res, 409, 'This invoice is frozen by a dispute.', 'text/plain');
      if (detail.invoice.status === 'matured' || detail.invoice.status === 'settled') return send(res, 409, 'This invoice is already at maturity.', 'text/plain');
      ensureParty(db, 'funders', { id: 'funder-demo', name: 'Sandbox Funder', paypalEmail: config.funderEmail || 'funder@example.com' });
      let slice = db.prepare("SELECT * FROM slices WHERE invoice_id = ? AND status IN ('offered','committed')").get(id) as any;
      if (!slice) {
        const takenBp = Number((db.prepare(
          "SELECT COALESCE(SUM(share_bp), 0) AS n FROM slices WHERE invoice_id = ? AND status IN ('paid','committed')"
        ).get(id) as any).n);
        const shareBp = 10_000 - takenBp;
        addSlice(db, id, 'funder-demo', shareBp, Math.round(Number(detail.price.advance_cents) * shareBp / 10_000), 'offered');
        slice = db.prepare("SELECT * FROM slices WHERE invoice_id = ? AND status IN ('offered','committed')").get(id) as any;
      }
      if (slice.status === 'committed') {
        res.writeHead(303, { Location: `/invoices/${id}` });
        return res.end();
      }
      const order = await createFundingOrder(db, slice.id, config.sellerEmail, config.platformEmail);
      res.writeHead(303, { Location: order.approveLink ?? `/invoices/${id}` });
      return res.end();
    }
    const captureMatch = /^\/invoices\/([A-Za-z0-9_]+)\/capture$/.exec(path);
    if (req.method === 'POST' && captureMatch) {
      if (deny('capture')) return;
      const id = captureMatch[1];
      if (invoiceIsFrozen(db, id)) return send(res, 409, 'This invoice is frozen by a dispute.', 'text/plain');
      const slice = db.prepare("SELECT * FROM slices WHERE invoice_id = ? AND status = 'committed'").get(id) as any;
      if (!slice) return send(res, 409, 'Nothing is waiting to be captured for this invoice.', 'text/plain');
      const commitment = db.prepare('SELECT * FROM commitments WHERE slice_id = ?').get(slice.id) as any;
      const approval = await orderIsApproved(commitment.paypal_order_id);
      if (!approval.ok) {
        return send(res, 409, noticePage('Not approved yet', `Order ${commitment.paypal_order_id} is ${approval.status}. The funder has to approve it in the sandbox before it can be captured.`, `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      await captureFunding(db, slice.id);
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    const settleMatch = /^\/invoices\/([A-Za-z0-9_]+)\/settle$/.exec(path);
    if (req.method === 'POST' && settleMatch) {
      if (deny('settle')) return;
      const id = settleMatch[1];
      const detail = invoiceDetail(db, id);
      if (!detail) return send(res, 404, 'Not found', 'text/plain');
      if (detail.invoice.status === 'disputed') return send(res, 409, 'This invoice is frozen by a dispute.', 'text/plain');
      const result = await createMaturityOrder(db, id);
      res.writeHead(303, { Location: result.approveLink ?? `/invoices/${id}` });
      return res.end();
    }
    const settleCaptureMatch = /^\/invoices\/([A-Za-z0-9_]+)\/settle\/capture$/.exec(path);
    if (req.method === 'POST' && settleCaptureMatch) {
      if (deny('capture')) return;
      const id = settleCaptureMatch[1];
      if (invoiceIsFrozen(db, id)) return send(res, 409, 'This invoice is frozen by a dispute.', 'text/plain');
      const row = db.prepare('SELECT * FROM maturity_orders WHERE invoice_id = ?').get(id) as any;
      if (!row) return send(res, 409, 'No maturity order for this invoice.', 'text/plain');
      const approval = await orderIsApproved(row.paypal_order_id);
      if (!approval.ok) {
        return send(res, 409, noticePage('Not approved yet', `The debtor's order ${row.paypal_order_id} is ${approval.status}. Approve it in the sandbox, then capture.`, `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      await captureMaturity(db, id);
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    // The three desk-only calls on a paper that did not pay. Each one is a state transition with a
    // precondition, so a refusal here is the book protecting itself, not a form validation failure:
    // answer 409 with the reason rather than a 500 page.
    const defaultMatch = /^\/invoices\/([A-Za-z0-9_]+)\/default$/.exec(path);
    if (req.method === 'POST' && defaultMatch) {
      if (deny('default')) return;
      const id = defaultMatch[1];
      try {
        declareDefault(db, id);
      } catch (err: any) {
        return send(res, 409, noticePage('Cannot declare default', String(err?.message ?? err), `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    const repurchaseMatch = /^\/invoices\/([A-Za-z0-9_]+)\/repurchase$/.exec(path);
    if (req.method === 'POST' && repurchaseMatch) {
      if (deny('repurchase')) return;
      const id = repurchaseMatch[1];
      const form = new URLSearchParams(await readBody(req, 100_000));
      const amount = parseMoneyToCents(form.get('amount') ?? '');
      if (!amount || amount <= 0) {
        return send(res, 400, noticePage('No amount', 'Enter what the seller actually paid, in dollars.', `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      try {
        collectRepurchase(db, id, amount);
      } catch (err: any) {
        return send(res, 409, noticePage('Cannot apply the repurchase', String(err?.message ?? err), `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    const writeOffMatch = /^\/invoices\/([A-Za-z0-9_]+)\/write-off$/.exec(path);
    if (req.method === 'POST' && writeOffMatch) {
      if (deny('write off')) return;
      const id = writeOffMatch[1];
      try {
        writeOffClaim(db, id);
      } catch (err: any) {
        return send(res, 409, noticePage('Cannot write the claim off', String(err?.message ?? err), `/invoices/${id}`), 'text/html; charset=utf-8');
      }
      res.writeHead(303, { Location: `/invoices/${id}` });
      return res.end();
    }
    if (req.method === 'POST' && path === '/webhooks/paypal') {
      const raw = await readBody(req);
      let event: any = null;
      try { event = JSON.parse(raw); } catch { return send(res, 400, 'bad json', 'text/plain'); }
      const verified = await verifyWebhookSignature(req.headers as any, event).catch(() => ({ ok: false }));
      const existing = db.prepare('SELECT id FROM webhook_events WHERE event_id = ?').get(event.id) as any;
      if (existing) return send(res, 200, 'duplicate', 'text/plain');
      const eventRowId = newId('wh');
      db.prepare('INSERT INTO webhook_events (id, event_id, type, payload_json, verified, received_at) VALUES (?,?,?,?,?,?)')
        .run(eventRowId, event.id, event.event_type ?? 'UNKNOWN', raw, verified.ok ? 1 : 0, nowIso());
      if (!verified.ok) return send(res, 200, 'unverified, stored', 'text/plain');
      const type = String(event.event_type ?? 'UNKNOWN');
      const resolution = resolveWebhookInvoice(db, event);
      let outcome = 'unmatched';
      if (type === 'CUSTOMER.DISPUTE.CREATED' || type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
        if (resolution) {
          const freeze = freezeForDispute(db, resolution.invoiceId, { eventId: event.id, via: resolution.via, kind: type, reason: event?.resource?.reason ?? null });
          outcome = freeze.frozen ? `froze ${resolution.invoiceId} (${freeze.previousStatus}) via ${resolution.via}` : `already ${freeze.previousStatus}`;
        }
      } else if (type === 'CUSTOMER.DISPUTE.RESOLVED') {
        if (resolution) {
          const release = releaseFreeze(db, resolution.invoiceId, { eventId: event.id, via: resolution.via });
          outcome = release.heldForClawback
            ? `held ${resolution.invoiceId} frozen: the capture was clawed back`
            : release.restoredTo
              ? `released ${resolution.invoiceId} to ${release.restoredTo} via ${resolution.via}`
              : `not frozen`;
        }
      } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        const settled = markCaptureCompleted(db, String(event?.resource?.id ?? ''));
        outcome = settled > 0
          ? `capture ${event?.resource?.id} cleared on ${settled} funding commitment${settled === 1 ? '' : 's'}`
          : resolution
            ? `capture recorded against ${resolution.invoiceId} via ${resolution.via}; no funding commitment carries it`
            : 'no invoice to match';
      }
      db.prepare('UPDATE webhook_events SET invoice_id = ?, outcome = ? WHERE id = ?')
        .run(resolution?.invoiceId ?? null, outcome, eventRowId);
      db.prepare('UPDATE webhook_events SET processed_at = ? WHERE event_id = ?').run(nowIso(), event.id);
      return send(res, 200, 'ok', 'text/plain');
    }
    if (req.method === 'GET' && path === '/health') {
      const chain = verifyChain(db);
      return send(res, 200, JSON.stringify({ ok: chain.ok, audit: chain, sandbox: isSandbox() }), 'application/json');
    }
    return send(res, 404, layout404(), 'text/html; charset=utf-8');
  } catch (err: any) {
    console.error(err);
    return send(res, 500, `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;background:#f4efe4;color:#191712"><h1>Something failed</h1><pre>${esc(err?.message ?? err)}</pre></body>`);
  }
});

function layout404(): string {
  return `<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;padding:40px;background:#f4efe4;color:#191712"><h1>Not found</h1><p><a href="/">The book</a></p></body>`;
}

server.listen(config.port, () => {
  console.log(`The Discount Window on http://localhost:${config.port}  (${config.paypalBase})`);
  console.log(`protection override: ${ALLOW_OVERRIDE ? 'available (sandbox only)' : 'off'}`);
});
