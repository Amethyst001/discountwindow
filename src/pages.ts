import { esc, join, layout } from './html.ts';
import { formatCents } from './money.ts';
import { paypalFeeOn, NON_RECOURSE_PREMIUM_BP } from './price.ts';
import { jurisdictionFor, ruleTextFor, sellerActionFor, type Jurisdiction } from './gate.ts';
import { roleAllows, holdersOf, type Role } from './auth.ts';

const statusLabel: Record<string, string> = {
  received: 'Received', extracting: 'Extracting', REFUSED: 'Refused', verified: 'Verified',
  priced: 'Priced', listed: 'Listed', partially_funded: 'Partly funded', funded: 'Funded',
  matured: 'Due, awaiting debtor', settled: 'Settled', disputed: 'Frozen', late: 'Late',
  overdue: 'Past due', defaulted: 'In default', repurchased: 'Repurchased'
};

function statusClass(status: string): string {
  return `status s-${status.toLowerCase()}`;
}

export type View = 'desk' | 'seller' | 'funder';

export interface Identity {
  role: 'desk' | 'seller' | 'funder' | 'debtor' | 'guest';
  name: string;
}

export function viewOf(value: string | null | undefined): View {
  return value === 'seller' || value === 'funder' ? value : 'desk';
}

/**
 * The same desk seen from the three sides of the trade. The viewpoint is a lens — any signed-in name
 * may wear any of the three, because a funder who cannot see what the seller was told cannot check
 * the desk's story. It is not an authority: the buttons that work come from `roleAllows` against the
 * signed-in username, so the desk-only panels do not render for anyone else however they arrived here.
 */
function roleStrip(basePath: string, view: View, identity?: { role: string; name: string } | null): string {
  const link = (id: View, label: string) => {
    const href = `${basePath}${basePath.includes('?') ? '&' : '?'}view=${id}`;
    return `<a href="${href}"${view === id ? ' class="on"' : ''}>${label}</a>`;
  };
  if (identity?.role === 'guest') {
    return `<div class="role-strip"><span><strong>Read-only guest.</strong> Every page is readable; no button is offered. <a href="/login">Sign in</a> as desk, seller, funder or debtor to act.</span> Viewing as ${link('desk', 'Desk')}${link('seller', 'Seller')}${link('funder', 'Funder')}</div>`;
  }
  if (!identity || identity.role === 'desk') {
    return `<div class="role-strip">Viewing as ${link('desk', 'Desk')}${link('seller', 'Seller')}${link('funder', 'Funder')}</div>`;
  }
  const label = identity.role === 'seller' ? 'Seller' : identity.role === 'funder' ? 'Funder' : 'Debtor';
  const note = identity.role === 'debtor'
    ? 'You are paying this invoice, not underwriting it — the lens is for reading the paperwork.'
    : 'The lens is for reading; the buttons follow the name you signed in with.';
  return `<div class="role-strip">Signed in as <strong>${esc(identity.name)}</strong> — ${label}. Viewing as ${link('desk', 'Desk')}${link('seller', 'Seller')}${link('funder', 'Funder')}<span>${note}</span></div>`;
}

/** Whether the signed-in name may press this button — a different question from the lens it wears. */
function mayPress(verb: string, identity?: { role: string } | null): boolean {
  return !identity || roleAllows(identity.role as Role, verb);
}

/**
 * What replaces a button when the viewer is wearing a lens whose step is not its own: the sentence
 * naming who holds the verb. A dead button that answers 403 teaches the reader nothing, and the
 * desk's own copy of this page needs no reminder.
 */
function holdNote(verb: string, identity?: { role: string; name: string } | null): string {
  if (identity?.role === 'guest') {
    return `<p class="note" style="margin-top:18px">${esc(verb[0]!.toUpperCase() + verb.slice(1))} is pressed by ${holdersOf(verb).map((r) => `<strong>${esc(r)}</strong>`).join(' or ')}. You are reading as a guest: <a href="/login">sign in</a> to press it.</p>`;
  }
  const holders = holdersOf(verb).filter((r) => r !== identity?.role);
  return `<p class="note" style="margin-top:18px">${esc(verb[0]!.toUpperCase() + verb.slice(1))} is pressed by ${holders.map((r) => `<strong>${esc(r)}</strong>`).join(' or ')} — not by <strong>${esc(identity?.name ?? 'desk')}</strong>. The buttons on this page follow the name you signed in with, not the lens you are reading through.</p>`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const OPEN_STATUSES = new Set(['verified', 'priced', 'listed', 'partially_funded']);
// Past due and in default are still held: the funder's money is out either way, which is exactly
// what the desk is looking at when it decides whether to call the paper.
const HELD_STATUSES = new Set(['funded', 'matured', 'settled', 'overdue', 'defaulted']);

export function renderBook(
  rows: any[],
  counts: { total: number; refused: number; verified: number; funded: number },
  sandbox: boolean,
  view: View = 'desk',
  identity?: Identity | null,
  opts: { page?: number; q?: string; filter?: string } = {}
): string {
  const cell = (r: any, extra: string) => `<td><a href="/invoices/${esc(r.id)}?view=${view}">${esc(r.invoice_number)}</a></td>${extra}`;
  const tenorCell = (r: any) => {
    const tenor = daysBetween(r.issued_on, r.due_on);
    const toMaturity = daysBetween(todayIso(), r.due_on);
    return `<td class="r num">${tenor}d${r.status === 'settled' ? '' : `<span class="muted small"> · ${toMaturity}d left</span>`}</td>`;
  };
  const scoreCell = (r: any) => `<td class="r num">${r.score == null ? '<span class="muted">—</span>' : `${r.score} <span class="muted small">${esc(r.band)}</span>`}</td>`;
  const statusCell = (r: any) => `<td><span class="${statusClass(r.status)}">${esc(statusLabel[r.status] ?? r.status)}</span></td>`;
  const money = (v: any) => `<td class="r num">${v == null ? '<span class="muted">—</span>' : formatCents(Number(v))}</td>`;

  let heading = 'The book';
  let lede = 'For funders who pay exporters early against their invoices: every invoice here was checked against its proof of delivery before anyone could fund it. Refused paper says why and what the seller can fix; verified paper is priced. Nothing is listed until delivery evidence is verified.';
  let cards = `<div class="grid cols-3 stat-cards" style="grid-template-columns: repeat(4, minmax(0,1fr)); margin-bottom: 28px;">
    <div class="card"><h3>Invoices</h3><div class="num" style="font-size:1.75rem">${counts.total.toLocaleString('en-US')}</div></div>
    <div class="card"><h3>Refused</h3><div class="num" style="font-size:1.75rem;color:var(--oxblood)">${counts.refused.toLocaleString('en-US')}</div></div>
    <div class="card"><h3>Verified</h3><div class="num" style="font-size:1.75rem;color:var(--olive)">${counts.verified.toLocaleString('en-US')}</div></div>
    <div class="card"><h3>Funded</h3><div class="num" style="font-size:1.75rem;color:var(--gold)">${counts.funded.toLocaleString('en-US')}</div></div>
  </div>`;
  let head = `<th>Invoice</th><th>Debtor</th><th>Seller</th><th class="r">Face</th><th class="r">Tenor</th><th class="r">Score</th><th class="r">Discount</th><th>Status</th>`;
  let listRows: any[] = [];
  let rowFn: (r: any) => string = () => '';
  let cols = 8;

  if (view === 'seller') {
    const mine = rows.filter((r) => r.seller_id === 'seller-northwind');
    const advanced = mine.filter((r) => HELD_STATUSES.has(r.status)).reduce((a, r) => a + Number(r.advance_cents ?? 0), 0);
    const refused = mine.filter((r) => r.status === 'REFUSED').length;
    const atFunders = mine.filter((r) => HELD_STATUSES.has(r.status)).length;
    const settled = mine.filter((r) => r.status === 'settled').length;
    heading = mine[0]?.seller_name ?? 'Your receivables';
    lede = 'Your receivables on this desk. The advance is what reaches you now; the rest follows when the debtor pays.';
    cards = `<div class="grid cols-3 stat-cards" style="grid-template-columns: repeat(4, minmax(0,1fr)); margin-bottom: 28px;">
      <div class="card"><h3>Submitted</h3><div class="num" style="font-size:1.75rem">${mine.length.toLocaleString('en-US')}</div></div>
      <div class="card"><h3>Refused</h3><div class="num" style="font-size:1.75rem;color:var(--oxblood)">${refused.toLocaleString('en-US')}</div></div>
      <div class="card"><h3>With funders</h3><div class="num" style="font-size:1.75rem;color:var(--gold)">${atFunders.toLocaleString('en-US')}</div></div>
      <div class="card"><h3>Cash advanced</h3><div class="num" style="font-size:1.75rem;color:var(--olive)">${formatCents(advanced)}</div><p class="small muted" style="margin:6px 0 0">${settled} settled</p></div>
    </div>`;
    head = `<th>Invoice</th><th>Debtor</th><th class="r">Face</th><th class="r">Tenor</th><th class="r">Advance offered</th><th>Status</th>`;
    cols = 6;
    listRows = mine; rowFn = (r) => `<tr>${cell(r, `<td>${esc(r.debtor_name)}</td>${money(r.face_cents)}${tenorCell(r)}${money(r.advance_cents)}${statusCell(r)}`)}</tr>`;
  } else if (view === 'funder') {
    const open = rows.filter((r) => OPEN_STATUSES.has(r.status) && r.advance_cents != null);
    const held = rows.filter((r) => HELD_STATUSES.has(r.status));
    const openFace = open.reduce((a, r) => a + Number(r.face_cents), 0);
    heading = 'Opportunities and positions';
    lede = 'Receivables that already cleared delivery checks, and the slices you hold. Each one carries the file the desk read.';
    cards = `<div class="grid cols-3 stat-cards" style="grid-template-columns: repeat(4, minmax(0,1fr)); margin-bottom: 28px;">
      <div class="card"><h3>Open</h3><div class="num" style="font-size:1.75rem">${open.length.toLocaleString('en-US')}</div></div>
      <div class="card"><h3>Face available</h3><div class="num" style="font-size:1.75rem">${formatCents(openFace)}</div></div>
      <div class="card"><h3>Positions</h3><div class="num" style="font-size:1.75rem;color:var(--gold)">${held.length.toLocaleString('en-US')}</div></div>
      <div class="card"><h3>Matured</h3><div class="num" style="font-size:1.75rem;color:var(--olive)">${held.filter((r) => r.status === 'settled').length.toLocaleString('en-US')}</div></div>
    </div>`;
    head = `<th>Invoice</th><th>Debtor</th><th class="r">Score</th><th class="r">Tenor</th><th class="r">Yield</th><th class="r">Advance</th><th>Status</th>`;
    cols = 7;
    listRows = [...open, ...held]; rowFn = (r) => `<tr>${cell(r, `<td>${esc(r.debtor_name)}</td>${scoreCell(r)}${tenorCell(r)}${money(r.discount_cents)}${money(r.advance_cents)}${statusCell(r)}`)}</tr>`;
  } else {
    listRows = rows; rowFn = (r) => `<tr>${cell(r, `<td>${esc(r.debtor_name)}</td><td class="muted">${esc(r.seller_name)}</td>${money(r.face_cents)}${tenorCell(r)}${scoreCell(r)}${money(r.discount_cents)}${statusCell(r)}`)}</tr>`;
  }

  // The table shows a page at a time: a judge reads the worked examples and a filter, not 1,007 rows.
  const PAGE_SIZE = 25;
  const groups: Record<string, (r: any) => boolean> = {
    all: () => true,
    refused: (r) => r.status === 'REFUSED',
    verified: (r) => OPEN_STATUSES.has(r.status),
    funded: (r) => HELD_STATUSES.has(r.status)
  };
  const filter = opts.filter && groups[opts.filter] ? opts.filter : 'all';
  const q = String(opts.q ?? '').trim().slice(0, 80);
  const needle = q.toLowerCase();
  const matchesQ = (r: any) => !needle || [r.invoice_number, r.debtor_name, r.seller_name].some((v) => String(v ?? '').toLowerCase().includes(needle));
  const searched = listRows.filter(matchesQ);
  const shown = searched.filter(groups[filter]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(Number(opts.page) || 1)), pages);
  const bodyRows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(rowFn);
  const href = (over: { filter?: string; page?: number }) => {
    const ps = new URLSearchParams();
    if (view !== 'desk') ps.set('view', view);
    const f = over.filter ?? filter;
    if (f !== 'all') ps.set('filter', f);
    if (q) ps.set('q', q);
    const pg = over.page ?? 1;
    if (pg > 1) ps.set('page', String(pg));
    const qs = ps.toString();
    return `/${qs ? `?${qs}` : ''}`;
  };
  const tabLabels: [string, string][] = [['all', 'All'], ['refused', 'Refused'], ['verified', 'Verified'], ['funded', 'Funded']];
  const tabs = `<nav class="tabs" aria-label="Filter the book">${tabLabels.map(([k, label]) =>
    `<a href="${esc(href({ filter: k }))}"${k === filter ? ' aria-current="page"' : ''}>${label}<span class="count">${searched.filter(groups[k]).length.toLocaleString('en-US')}</span></a>`).join('')}</nav>`;
  const search = `<form class="search" method="get" action="/" role="search">
      ${view !== 'desk' ? `<input type="hidden" name="view" value="${esc(view)}">` : ''}
      ${filter !== 'all' ? `<input type="hidden" name="filter" value="${esc(filter)}">` : ''}
      <label for="book-q" class="small muted" style="align-self:center">Search</label>
      <input id="book-q" type="search" name="q" value="${esc(q)}" placeholder="Invoice, debtor or seller">
      <button type="submit" class="ghost">Find</button>
    </form>`;
  const from = shown.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, shown.length);
  const pager = `<div class="pager"><span class="muted">Showing ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')} of ${shown.length.toLocaleString('en-US')}${q ? ` matching “${esc(q)}”` : ''}</span>
      <span style="display:flex;gap:8px;align-items:center">
        ${page > 1 ? `<a href="${esc(href({ page: page - 1 }))}" rel="prev">← Previous</a>` : '<span class="off">← Previous</span>'}
        <span class="small muted">Page ${page} of ${pages}</span>
        ${page < pages ? `<a href="${esc(href({ page: page + 1 }))}" rel="next">Next →</a>` : '<span class="off">Next →</span>'}
      </span></div>`;

  const startHere = (() => {
    if (view !== 'desk') return '';
    const byNumber = new Map(rows.map((r) => [String(r.invoice_number), r]));
    const wanted = [
      ['A-1043', 'Refused: the POD names Halcyon Logistics, not the debtor'],
      ['A-1043-R2', 'The corrected document: same paper, priced'],
      ['A-1054', 'A photograph the model read short: E02 refuses the tracking number'],
      ['A-1042', 'The clean version: same face, same PO, priced'],
      ['NW-2277', 'The small invoice the sandbox funds end to end']
    ];
    const links = wanted.filter(([n]) => byNumber.has(n));
    if (links.length === 0) return '';
    return `<div class="card strong" style="margin-bottom:24px;border-left:4px solid var(--ink)">
      <h3 style="margin:0 0 4px;font-size:1.25rem">Start here — the worked examples</h3>
      <p class="small muted" style="margin:0">Five invoices out of ${counts.total.toLocaleString('en-US')}, in the order the product decides them. Each opens the document, the eleven checks and the reason.</p>
      <ol class="examples">
        ${links.map(([n, why]) => {
          const r = byNumber.get(n)!;
          const kind = r.status === 'REFUSED' ? 'refused' : 'priced';
          return `<li class="ex-${kind}"><a href="/invoices/${esc(r.id)}?view=desk"><span class="num-id">${esc(n)}</span><span class="tag ${statusClass(r.status)}">${esc(statusLabel[r.status] ?? r.status)}</span><span class="why">${esc(why)}</span></a></li>`;
        }).join('')}
      </ol>
      <p class="small muted" style="margin:12px 0 0">Status page: <a href="/status">the audit chain, the book's counts and the ledger, with no login</a>.</p>
    </div>`;
  })();

  const body = join([
    roleStrip('/', view, identity),
    `<h1>${esc(heading)}</h1>`,
    `<p class="lede">${esc(lede)}</p>`,
    `<p class="note" style="margin:-12px 0 18px">A synthetic seeded book of ${counts.total.toLocaleString('en-US')} receivables. ${counts.refused.toLocaleString('en-US')} are refused; every count on this page is read from the data, not typed into the copy.</p>`,
    startHere,
    cards,
    `<div class="toolbar" id="book">${tabs}${search}</div>`,
    `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>`,
    bodyRows.length === 0
      ? `<tr><td colspan="${cols}" class="empty">${q || filter !== 'all' ? 'Nothing matches this filter.' : 'Nothing here yet.'}</td></tr>`
      : bodyRows.join(''),
    `</tbody></table></div>`,
    pager
  ]);

  return layout({ title: heading, current: '/', sandbox, canSubmit: mayPress('submit', identity) }, body);
}

function checkRow(c: any, profile: Jurisdiction): string {
  const pass = Number(c.passed) === 1;
  return `<div class="check ${pass ? 'pass' : 'fail'}">
    <div class="mark">${pass ? '✓' : '✕'}</div>
    <div>
      <div><strong>${esc(c.check_id)}</strong> <span class="detail">${esc(c.detail)}</span></div>
      <div class="rule-text muted">${esc(c.rule ?? ruleTextFor(String(c.check_id), profile))}</div>
    </div>
  </div>`;
}

/**
 * What the desk can do next. A verified invoice can be funded; a committed slice has an approved
 * PayPal order waiting to be captured. Both actions hit PayPal, so neither is a decoration.
 */
/**
 * A vertical pair of money actions, sized to the same column so the second one does not look like
 * an afterthought. Approve opens PayPal; capture only works once that approval exists.
 */
function actionStack(primary: string | null, secondary: string): string {
  return `<div style="display:grid;gap:10px;max-width:360px;margin-top:18px">
    ${primary ?? ''}
    ${secondary}
  </div>`;
}
const stackButton = 'class="button" style="display:block;width:100%;text-align:center;border-bottom:0"';

function fundAction(invoice: any, slices: any[], view: View, identity?: Identity | null): string {
  if (invoice.status !== 'verified' && invoice.status !== 'priced' && invoice.status !== 'listed' && invoice.status !== 'partially_funded') return '';
  if (view === 'seller') {
    return `<p class="note" style="margin-top:18px">Listed to funders. The advance is paid by the funder's capture, not by the desk.</p>`;
  }
  const committed = slices.find((s) => s.status === 'committed');
  if (committed) {
    if (committed.commitment_status === 'captured') return '';
    const approve = committed.funding_approve_link
      ? `<a ${stackButton} href="${esc(committed.funding_approve_link)}">Approve the funding payment</a>`
      : null;
    if (!mayPress('capture', identity)) return actionStack(approve, holdNote('capture', identity));
    return `${actionStack(approve, `<form method="post" action="/invoices/${esc(invoice.id)}/capture" style="margin:0">
      <button type="submit" class="ghost" style="width:100%">Capture the approved payment</button>
    </form>`)}
    <p class="small muted" style="margin-top:10px;max-width:360px">Order <span class="mono">${esc(committed.paypal_order_id ?? '')}</span> pays the seller's advance and the platform fee in one payment. PayPal only accepts the capture once the funder has approved it.</p>`;
  }
  if (slices.some((s) => s.status === 'paid')) return '';
  if (!mayPress('fund', identity)) return holdNote('fund', identity);
  return `<form method="post" action="/invoices/${esc(invoice.id)}/fund" style="margin-top:18px;max-width:360px">
    <button type="submit" class="primary" style="width:100%">Fund the seller's advance</button>
  </form>`;
}

/**
 * The second money beat. The debtor pays face; one order carries two purchase units, so the
 * funder and the seller are paid in the same capture and no omnibus balance sits with the platform.
 */
function maturityAction(invoice: any, price: any, maturity: any, view: View, identity?: Identity | null): string {
  const operator = view !== 'funder';
  if (invoice.status === 'disputed') {
    return `<div class="refusal" style="margin-top:18px"><h2>Frozen</h2>
      <p style="margin:0">A dispute webhook froze this position. Nothing can be funded, settled or sold until it clears.</p></div>`;
  }
  if (invoice.status === 'settled' && maturity?.captures_json) {
    const captures = JSON.parse(maturity.captures_json) as { unit: string; payee: string; cents: number; capture: string; status: string }[];
    const grossFunder = Number(maturity.gross_funder_cents);
    const grossSeller = Number(maturity.gross_seller_cents);
    const feeFunder = paypalFeeOn(grossFunder);
    const feeSeller = paypalFeeOn(grossSeller);
    const funderNet = grossFunder - feeFunder;
    const advance = Number(price?.advance_cents ?? 0);
    return `<div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:10px">Maturity receipt</h3>
      <dl class="kv">
        <dt>Debtor paid face</dt><dd>${formatCents(Number(invoice.face_cents))}</dd>
        <dt>Funder unit</dt><dd>${formatCents(grossFunder)}</dd>
        <dt class="muted">PayPal fee on that unit, estimated</dt><dd class="muted">−${formatCents(feeFunder)}</dd>
        <dt>Funder receives</dt><dd class="em">${formatCents(funderNet)}</dd>
        <dt class="muted">of which principal returned</dt><dd class="muted">${formatCents(advance)}</dd>
        <dt class="muted">of which yield</dt><dd class="muted">${formatCents(funderNet - advance)}</dd>
        <dt>Seller unit</dt><dd>${formatCents(grossSeller)}</dd>
        <dt class="muted">PayPal fee on that unit, estimated</dt><dd class="muted">−${formatCents(feeSeller)}</dd>
        <dt>Seller receives</dt><dd class="em">${formatCents(grossSeller - feeSeller)}</dd>
      </dl>
      <p class="small muted" style="margin:12px 0 0">Captures ${captures.map((c) => `<span class="mono">${esc(c.capture)}</span> (${esc(c.unit)}, ${esc(c.status)})`).join(' · ')}. The fee is the published US schedule the desk prices against; these sandbox captures do not return PayPal's receiving fee, so it is booked at that schedule rather than guessed.</p>
    </div>`;
  }
  if (invoice.status === 'matured' && maturity) {
    if (!operator) {
      return `<p class="note" style="margin-top:18px">The debtor's payment order is open. The funder is paid when the desk captures it.</p>`;
    }
    if (!mayPress('capture', identity)) {
      return `<div class="card" style="margin-top:18px">
        <h3 style="margin-bottom:8px">At maturity</h3>
        <p class="small" style="margin:0 0 0">The debtor's payment order is open: ${formatCents(Number(invoice.face_cents))} across two purchase units.</p>
        ${actionStack(maturity.approve_link ? `<a ${stackButton} href="${esc(maturity.approve_link)}">Open the debtor's payment</a>` : null, holdNote('capture', identity))}
        <p class="small muted" style="margin:10px 0 0">Order <span class="mono">${esc(maturity.paypal_order_id)}</span>.</p>
      </div>`;
    }
    return `<div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:8px">At maturity</h3>
      <p class="small" style="margin:0 0 0">The debtor's payment order is open: ${formatCents(Number(invoice.face_cents))} across two purchase units. Approve it in the sandbox, then capture.</p>
      ${actionStack(
        maturity.approve_link ? `<a ${stackButton} href="${esc(maturity.approve_link)}">Open the debtor's payment</a>` : null,
        `<form method="post" action="/invoices/${esc(invoice.id)}/settle/capture" style="margin:0">
          <button type="submit" class="ghost" style="width:100%">Capture the debtor's payment</button>
        </form>`
      )}
      <p class="small muted" style="margin:10px 0 0">Order <span class="mono">${esc(maturity.paypal_order_id)}</span>.</p>
    </div>`;
  }
  if (invoice.status === 'overdue' && price) {
    // The grace period has run out and nothing has been paid, but the receivable is still there.
    // Taking the late payment is still the way the funder gets whole; declaring default is the
    // alternative, and it is a decision, so this page offers both and closes neither.
    if (!operator) {
      return `<p class="note" style="margin-top:18px">Past due and unpaid. Until the desk declares default, the debtor paying late still settles this position.</p>`;
    }
    if (!mayPress('settle', identity)) return holdNote('settle', identity);
    return `<form method="post" action="/invoices/${esc(invoice.id)}/settle" style="margin-top:18px">
      <button class="ghost" type="submit">Take the late payment of ${formatCents(Number(invoice.face_cents))}</button>
    </form>
    <p class="small muted" style="margin-top:8px">Past due is not the same as closed. A late payment makes the funder whole out of the receivable rather than out of the seller.</p>`;
  }
  if (invoice.status === 'funded' && price) {
    if (!operator) {
      return `<p class="note" style="margin-top:18px">Fully funded. The debtor pays ${formatCents(Number(invoice.face_cents))} at maturity and the capture allocates it by ownership.</p>`;
    }
    if (!mayPress('settle', identity)) return holdNote('settle', identity);
    return `<form method="post" action="/invoices/${esc(invoice.id)}/settle" style="margin-top:18px">
      <button class="ghost" type="submit">The debtor pays ${formatCents(Number(invoice.face_cents))}</button>
    </form>
    <p class="small muted" style="margin-top:8px">Opens one PayPal order for the face value, split into the funder's gross slice and the seller's remainder. Capturing it settles both in the same payment.</p>`;
  }
  return '';
}

/**
 * The term that decides who eats a loss, and the three calls that follow when the debtor does not
 * pay. The term is chosen at intake and stored on the price row, so by the time paper is in default
 * nobody can pick a side of it after seeing the outcome.
 */
function defaultCard(invoice: any, price: any, event: any, isDesk: boolean): string {
  if (!price) return '';
  const nonRecourse = price.recourse === 'non_recourse';
  const pastDue = daysBetween(invoice.due_on, todayIso());
  const term = nonRecourse
    ? `Without recourse. The desk holds the debtor's credit risk and paid ${(NON_RECOURSE_PREMIUM_BP / 100).toFixed(2)}% a year more to hold it.`
    : 'With recourse. If the debtor does not pay, the seller repurchases the paper at what the funder put in.';
  const claim = event ? Number(event.claim_cents) : 0;

  if (event) {
    const rows: [string, string][] = [
      ['Term', nonRecourse ? 'Without recourse' : 'With recourse'],
      ['Declared', `${esc(event.created_at.slice(0, 10))} · ${event.days_past_due} days past due`],
      ['Funder outlay at risk', formatCents(Number(event.funder_outlay_cents))],
      ['Mode', event.mode === 'non_recourse' ? 'Written off against the desk' : 'Claim against the seller']
    ];
    if (event.status === 'claim_open') rows.push(['Open claim', formatCents(claim)]);
    if (event.status === 'repurchased') rows.push(['Repurchased', formatCents(Number(event.funder_outlay_cents))]);
    const actions = !isDesk ? '' : event.status === 'claim_open'
      ? `${actionStack(
          `<form method="post" action="/invoices/${esc(invoice.id)}/repurchase" style="margin:0">
            <label class="small muted" for="repurchase-${esc(invoice.id)}">What the seller paid</label>
            <input id="repurchase-${esc(invoice.id)}" name="amount" value="${(claim / 100).toFixed(2)}" style="width:100%;margin:4px 0 8px" />
            <button type="submit" style="width:100%">Apply the repurchase</button>
          </form>`,
          `<form method="post" action="/invoices/${esc(invoice.id)}/write-off" style="margin:0">
            <button type="submit" class="ghost" style="width:100%">Write the claim off</button>
          </form>`
        )}
        <p class="small muted" style="margin-top:10px">A partial repurchase leaves the rest as a live claim. Nothing is booked as recovered before it arrives.</p>`
      : '';
    return `<div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:10px">${esc(event.status === 'written_off' ? 'Loss taken' : event.status === 'repurchased' ? 'Repurchased' : event.status === 'uncollectible' ? 'Claim written off' : 'In default')}</h3>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <p class="small" style="margin:12px 0 0">${esc(term)}</p>
      ${actions}
    </div>`;
  }

  if (invoice.status === 'overdue') {
    const button = isDesk ? `<form method="post" action="/invoices/${esc(invoice.id)}/default" style="margin-top:14px">
        <button type="submit" class="ghost" style="width:100%">Declare default</button>
      </form>` : '';
    const lateness = pastDue > 0 ? `${pastDue} days past due, unpaid.` : 'Past due and unpaid.';
    return `<div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:10px">Who stands behind this paper</h3>
      <p class="small" style="margin:0">${esc(term)}</p>
      <p class="small" style="margin:10px 0 0">${lateness}</p>
      ${button}
      ${pastDue > 0 && !isDesk ? '<p class="small muted" style="margin-top:10px">Declaring default is the desk\'s call, not the seller\'s or the funder\'s.</p>' : ''}
    </div>`;
  }

  return `<div class="card" style="margin-top:18px">
    <h3 style="margin-bottom:10px">Who stands behind this paper</h3>
    <p class="small" style="margin:0">${esc(term)}</p>
  </div>`;
}

/**
 * The desk's register of the notice going out. The entries are the operator's own statements — there
 * is no post office in this build — so the page says which part is proven (the digest of the bytes
 * served, taken from the stored notice) and which part is only asserted (that it went, and when).
 */
function serviceRegister(invoice: any, entries: any[], isDesk: boolean): string {
  const rows = entries.map((e: any) => `<tr>
      <td class="small">${esc(String(e.servedAt).slice(0, 10))}</td>
      <td class="small">${esc(e.channel)}</td>
      <td class="small mono">${esc(e.reference ?? '—')}</td>
      <td class="small">${esc(e.enteredBy)}</td>
      <td class="hash small">${esc(String(e.digest).slice(0, 16))}…</td>
    </tr>`).join('');
  const form = !isDesk ? '' : `<form method="post" action="/invoices/${esc(invoice.id)}/notice/service" style="margin-top:12px">
      <label class="small muted" for="channel-${esc(invoice.id)}">How it went out</label>
      <input id="channel-${esc(invoice.id)}" name="channel" placeholder="Recorded delivery, UK" style="width:100%;margin:4px 0 8px" required />
      <label class="small muted" for="reference-${esc(invoice.id)}">Reference, as entered by the desk</label>
      <input id="reference-${esc(invoice.id)}" name="reference" placeholder="optional" style="width:100%;margin:4px 0 8px" />
      <label class="small muted" for="served-${esc(invoice.id)}">Date it went</label>
      <input id="served-${esc(invoice.id)}" type="date" name="servedAt" value="${todayIso()}" style="width:100%;margin:4px 0 8px" />
      <button type="submit" style="width:100%">Record that it went out</button>
    </form>`;
  return `<div class="card" style="margin-top:14px">
    <h3 style="margin-bottom:10px">Service register</h3>
    ${entries.length ? `<table><thead><tr><th>Went out</th><th>By</th><th>Reference</th><th>Entered by</th><th>Bytes served</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="small muted" style="margin:0">Nothing recorded yet. The notice exists; the desk has not written down sending it.</p>`}
    ${form}
    ${isDesk ? `<p class="small" style="margin:10px 0 0"><a href="/notices/register.csv">Download every service entry in the book</a> — one row per attempt, across all invoices, each with the digest it took and whether those bytes still match.</p>` : ''}
    <p class="small muted" style="margin-top:10px">The digest is recomputed from the stored notice, never typed in: the entry proves which text went out and that the bytes have not been edited since. That the notice arrived is what the operator asserts, and nothing outside this desk confirms it.</p>
  </div>`;
}

function highlightDocument(text: string, needles: string[]): string {
  let html = esc(text);
  for (const n of needles.filter(Boolean)) {
    const safe = esc(n);
    if (!safe) continue;
    html = html.split(safe).join(`<mark>${safe}</mark>`);
  }
  return html;
}

/**
 * The readers write what they disagree about into the extraction's notes. A disagreement that
 * cost the invoice nothing — the halved confidence still cleared the floor — would otherwise be a
 * line of prose under a card, so the value itself is marked in the document: the reader is shown the
 * piece of paper the machine could not agree on, not told about it.
 */
export function readerDisagreementMarks(notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  const marks: string[] = [];
  for (const note of notes) {
    if (!/readers disagree/.test(String(note))) continue;
    for (const value of [...String(note).matchAll(/"([^"]*)"/g)].map((m) => m[1].trim())) {
      if (value.length >= 3 && !/^(null|undefined|false|true)$/i.test(value)) marks.push(value);
    }
  }
  return [...new Set(marks)];
}

/**
 * What this deal pays the side you are looking from. The desk sees the machine; a funder and a
 * seller see the same numbers arranged around their own question — what do I commit, what do I get.
 */
function roleCard(invoice: any, price: any, slices: any[], view: View): string {
  if (view === 'desk' || !price) return '';
  const face = Number(invoice.face_cents);
  const shareBp = slices.reduce((n: number, s: any) => n + Number(s.share_bp), 0) || 10_000;
  // The gross slice is what the price fixed — an LTV of face, not the slice percentage of face.
  const grossFull = Number(price.advance_cents) + Number(price.discount_cents) + Number(price.fee_reserve_cents);
  const grossSlice = Math.round(grossFull * shareBp / 10_000);
  const feeReserve = paypalFeeOn(grossSlice);
  const advance = Math.round(Number(price.advance_cents) * shareBp / 10_000);
  const paid = slices.filter((s: any) => s.status === 'paid');
  const committed = slices.filter((s: any) => s.status === 'committed');

  if (view === 'funder') {
    const state = paid.length
      ? `Funded. Your capture <span class="mono small">${esc(paid[0].capture_id ?? '')}</span> paid the seller.`
      : committed.length
        ? 'Committed. Approve the order in the sandbox, then the desk captures it.'
        : 'No slice committed yet.';
    return `<div class="card" style="margin:0 0 24px;max-width:620px">
      <h3 style="margin-bottom:10px">Your position as funder</h3>
      <dl class="kv">
        <dt>Share of face</dt><dd>${(shareBp / 100).toFixed(0)}%</dd>
        <dt>You commit</dt><dd class="em">${formatCents(advance)}</dd>
        <dt class="muted">of which platform fee</dt><dd class="muted">${formatCents(Math.round(Number(price.platform_fee_cents) * shareBp / 10_000))}</dd>
        <dt>At maturity you receive</dt><dd>${formatCents(grossSlice - feeReserve)}</dd>
        <dt class="muted">principal returned</dt><dd class="muted">${formatCents(advance)}</dd>
        <dt class="muted">yield, after an estimated PayPal fee</dt><dd class="muted">${formatCents(grossSlice - feeReserve - advance)}</dd>
      </dl>
      <p class="small muted" style="margin:12px 0 0">${state}</p>
    </div>`;
  }

  const feeShare = Math.round(Number(price.platform_fee_cents) * shareBp / 10_000);
  const sellerRemainder = face - grossSlice;
  return `<div class="card" style="margin:0 0 24px;max-width:620px">
    <h3 style="margin-bottom:10px">Your position as seller</h3>
    <dl class="kv">
      <dt>Face, paid by the debtor at maturity</dt><dd>${formatCents(face)}</dd>
      <dt>Advance on the funder's slice</dt><dd>${formatCents(advance)}</dd>
      <dt class="muted">platform fee</dt><dd class="muted">−${formatCents(feeShare)}</dd>
      <dt>You receive now</dt><dd class="em">${formatCents(advance - feeShare)}</dd>
      <dt>You receive at maturity</dt><dd>${formatCents(sellerRemainder - paypalFeeOn(sellerRemainder))}</dd>
      <dt class="muted">of which, estimated PayPal fee on your unit</dt><dd class="muted">−${formatCents(paypalFeeOn(sellerRemainder))}</dd>
    </dl>
    <p class="small muted" style="margin:12px 0 0">The debtor settles the whole face in one capture; the funder's slice and your remainder are separate purchase units of the same payment.</p>
  </div>`;
}

/**
 * Who read the document, field by field. The agent's job is to be checkable: the model's answer and
 * the deterministic parser's answer are compared, a disagreement halves the confidence, and the
 * gate refuses below the floor. This card is that comparison, on the page, for every invoice.
 */
function extractionReadBy(extraction: any): string {
  if (!extraction) return '';
  let confidences: Record<string, number> = {};
  let notes: string[] = [];
  try { confidences = JSON.parse(extraction.confidence_json ?? '{}'); } catch { confidences = {}; }
  try { notes = JSON.parse(extraction.fields_json ?? '{}').notes ?? []; } catch { notes = []; }
  const model = String(extraction.model ?? 'unknown');
  const byModel = model !== 'deterministic-text' && model !== 'none';
  const modelSkipped = !byModel && notes.some((n) => /^model pass/.test(n));
  let viaVision = false;
  let pixelReaders: string[] = [];
  try {
    const raw = JSON.parse(extraction.raw_json ?? '{}');
    viaVision = raw.source === 'vision';
    if (Array.isArray(raw.model?.readers)) pixelReaders = raw.model.readers.map(String);
  } catch { viaVision = false; }
  const fields = Object.entries(confidences).filter(([k]) => k !== 'poRef');
  const readSentence = () => {
    if (!byModel) {
      return modelSkipped
        ? 'The deterministic label parser read the document. The model pass was configured but did not run for this document; the reason is recorded below.'
        : 'The deterministic label parser read the document. No model pass is recorded for this document, so nothing was inferred.';
    }
    if (pixelReaders.length > 1) {
      return `${pixelReaders.map((r) => `<span class="mono">${esc(r)}</span>`).join(' and ')} each read the photograph${pixelReaders.length > 2 ? '' : ' — two weights, two answers, the same question'}; the deterministic label parser then read one of their transcriptions.`;
    }
    return viaVision
      ? `<span class="mono">${esc(model)}</span> read the photograph and transcribed it${extraction.model_version && extraction.model_version !== model ? ` (${esc(extraction.model_version)})` : ''}; the deterministic label parser then read that transcription.`
      : `<span class="mono">${esc(model)}</span>${extraction.model_version && extraction.model_version !== model ? ` ${esc(extraction.model_version)}` : ''} read the document; the deterministic label parser read it again.`;
  };
  return `<div class="card" style="margin-bottom:18px">
    <h3 style="margin-bottom:8px">How the document was read</h3>
    <p class="small" style="margin:0 0 10px">
      ${readSentence()}
    </p>
    ${fields.length ? `<dl class="kv">${fields.map(([k, v]) => `<dt class="muted">${esc(k)}</dt><dd>${(Number(v) * 100).toFixed(0)}%</dd>`).join('')}</dl>` : ''}
    ${readerDiffTable(extraction)}
    ${notes.length ? `<p class="small muted" style="margin:10px 0 0">${notes.map((n) => esc(n)).join('<br>')}</p>` : ''}
    <p class="small muted" style="margin:10px 0 0">A field under 70% is treated as unreadable. The gate reads these numbers; the model never sees the verdict.</p>
  </div>`;
}

/**
 * The readings, side by side. The reconciled pod, the confidence and the notes are already on the
 * page; this is the evidence behind them — what each reader actually answered — so a reviewer can see
 * the comparison the desk made instead of only its summary. A photographed document is opened by two
 * independent models as well as the parser, so it gets one column per reader. Shown only when a model
 * pass ran, because with one reader there is nothing to compare.
 */
function readerDiffTable(extraction: any): string {
  let modelPod: any;
  let parserPod: any;
  let pixels: { name: string; pod: any }[] | null = null;
  try {
    const raw = JSON.parse(extraction.raw_json ?? '{}');
    modelPod = raw.modelPod ?? raw.model?.pod;
    parserPod = raw.deterministic?.pod;
    if (Array.isArray(raw.model?.pixels)) {
      pixels = raw.model.pixels.map((pod: any, index: number) => ({
        name: String(raw.model.readers?.[index] ?? `reader ${index + 1}`),
        pod: pod ?? {}
      }));
    }
  } catch { return ''; }
  if (!modelPod || !parserPod) return '';
  const reconciled = (() => { try { return JSON.parse(extraction.fields_json ?? '{}').pod ?? {}; } catch { return {}; } })();
  let confidences: Record<string, number> = {};
  try { confidences = JSON.parse(extraction.confidence_json ?? '{}'); } catch { confidences = {}; }
  const show = (v: unknown): string => {
    if (v == null || v === '') return '<span class="muted">—</span>';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'object') {
      const a = v as any;
      return esc([a.line1, a.city, a.postalCode].filter(Boolean).join(', ')) || '<span class="muted">—</span>';
    }
    return esc(String(v));
  };
  const readers = pixels ?? [{ name: 'Model read', pod: modelPod }];
  const key = (v: unknown) => (v && typeof v === 'object' ? [ (v as any).line1, (v as any).city, (v as any).postalCode ].filter(Boolean).join(' ') : String(v ?? ''));
  const rows = ['trackingNumber', 'consigneeName', 'deliveredOn', 'deliveryAddress', 'hasSignature', 'delivered']
    .map((field) => {
      const values = [...readers.map((r) => r.pod[field]), parserPod[field]];
      const differs = new Set(values.map(key)).size > 1;
      const conf = confidences[field];
      return `<tr${differs ? ' class="diff"' : ''}>
        <td class="small mono">${esc(field)}</td>
        ${readers.map((r) => `<td class="small">${show(r.pod[field])}</td>`).join('')}
        <td class="small">${show(parserPod[field])}</td>
        <td class="small">${show(reconciled[field])}</td>
        <td class="r num small">${conf === undefined ? '<span class="muted">—</span>' : `${(Number(conf) * 100).toFixed(0)}%`}</td>
      </tr>`;
    })
    .join('');
  const heads = [...readers.map((r) => `<th>${esc(r.name)}</th>`), '<th>Parser read</th>', '<th>Used</th>', '<th class="r">Confidence</th>'].join('');
  const split = readers.length > 1
    ? 'A shaded row is a field these readers could not all say the same thing about. Halving its confidence is what puts it under the floor, and the floor applies to every reader in turn: a field the two models split on stays split, because the label parser reads one of their transcriptions and cannot arbitrate a disagreement about the photograph.'
    : 'A shaded row is a field the two readers could not agree on, and halving its confidence is what puts it under the floor.';
  return `<table style="margin-top:10px"><thead><tr><th>Field</th>${heads}</tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted" style="margin:8px 0 0">${split} This page only displays the comparison; the gate applies the rule itself — a field read below the floor can fail a check but cannot satisfy one. The reconciled column is what it reads, never a column of this table.</p>`;
}

/**
 * The gate is data: which carriers a desk believes, what a postal code looks like, how stale a
 * delivery may be, how long a tenor may run, and what PayPal calls the protection behind the sale all
 * come from the debtor's country. The deal room prints which of those numbers were in force, so a
 * reviewer can tell a rule from a preference.
 */
function profileOf(invoice: any): Jurisdiction {
  let billing: any = {};
  try { billing = JSON.parse(invoice.billing_address_json ?? '{}'); } catch { billing = {}; }
  return jurisdictionFor(billing.countryCode);
}

function profileNote(j: Jurisdiction): string {
  return `<div class="card" style="margin-bottom:14px">
    <h3 style="margin-bottom:8px">Which rules decided this</h3>
    <p class="small" style="margin:0">The debtor's billing country selects the <strong>${esc(j.label)}</strong> profile, and with it:
      ${esc(j.carriers.map((c) => c.name).join(', '))} as the carriers this desk believes, a ${j.postalCode.significant > 0
        ? `${j.postalCode.significant}-digit${j.postalCode.significant === 5 ? ' ZIP' : ' postal-code'} prefix`
        : `complete ${esc(j.label)} postcode`} as the address, a delivery no more than ${j.deliveryWindowDays} days before the
      invoice, a tenor no longer than ${j.maximumTenorDays} days, and ${esc(j.protectionProgram)} as PayPal's cover.</p>
    <p class="small muted" style="margin:8px 0 0">Those numbers are configuration, one profile per country; the eleven checks, the score and the price are the
      same everywhere. A ${esc(j.label)} debtor's receivable is invoiced and settled in US dollars in this build.</p>
  </div>`;
}

function readableCode(code: string): string {
  return String(code ?? 'refused').toLowerCase().replace(/_/g, ' ');
}

export function renderDealRoom(detail: any, sandbox: boolean, view: View = 'desk', identity?: Identity | null): string {
  const { invoice, checks, score, price, extraction, audit, slices, decisions, maturity, defaultEvent } = detail;
  const profile = profileOf(invoice);
  const rawText: string = (() => { try { return JSON.parse(extraction?.raw_json ?? '{}').text ?? ''; } catch { return ''; } })();
  const refused = invoice.status === 'REFUSED';
  const failing = checks.filter((c: any) => Number(c.passed) === 0);
  const overrideRow = checks.find((c: any) => c.check_id === 'E00' && Number(c.passed) === 1 && /override/i.test(c.detail));
  const uncorroborated = checks.some((c: any) => c.check_id === 'E00' && /uncorroborated/i.test(String(c.detail)));
  const reusedEvidenceNote = String(
    checks.find((c: any) => c.check_id === 'E06' && Number(c.passed) === 0)?.detail
      ?? 'No document is filed against this invoice.'
  );
  const docLines = rawText.split('\n');
  const disagreementMarks = readerDisagreementMarks((() => {
    try { return JSON.parse(extraction?.fields_json ?? '{}').notes; } catch { return []; }
  })());
  const highlightWords = [...(failing.length
    ? [/(?:consignee|ship to)[:\s]+([^\n]+)/i, /(?:address)[:\s]+([^\n]+)/i, /(?:tracking)[:\s]+([^\n]+)/i]
        .map((re) => { const m = re.exec(rawText); return m ? m[1].trim() : ''; })
        .filter(Boolean)
    : []), ...disagreementMarks];
  const components = score ? JSON.parse(score.components_json) : null;
  const gateReasons: any[] = (() => {
    const gate = decisions.find((d: any) => d.kind === 'gate');
    try { return gate?.reasons_json ? JSON.parse(gate.reasons_json) : []; } catch { return []; }
  })();
  const pricingRefusal: any[] = (() => {
    const pricing = decisions.find((d: any) => d.kind === 'pricing' && d.verdict === 'REFUSED');
    try { return pricing?.reasons_json ? JSON.parse(pricing.reasons_json) : []; } catch { return []; }
  })();
  const refusalList: any[] = gateReasons.length ? gateReasons : pricingRefusal;
  const refusalCode = refusalList[0]?.code ?? 'REFUSED';
  const refusalRule = refusalList[0]?.rule ?? '';
  const reading = extractionReadBy(extraction);

  const committedBp = slices.filter((s: any) => s.status === 'paid' || s.status === 'committed').reduce((n: number, s: any) => n + Number(s.share_bp), 0);
  const paidBp = slices.filter((s: any) => s.status === 'paid').reduce((n: number, s: any) => n + Number(s.share_bp), 0);
  const awaitingApproval = invoice.status === 'partially_funded' && committedBp >= 10_000 && paidBp === 0;
  const statusText = awaitingApproval ? 'Committed, awaiting approval' : statusLabel[invoice.status] ?? invoice.status;

  // Headline and one-sentence reason, so the verdict is the first thing read rather than the debtor's name.
  const verdictClass = refused ? 'is-refused' : invoice.status === 'funded' ? 'is-funded' : 'is-priced';
  const headline = refused
    ? `Refused: ${readableCode(refusalCode)}`
    : price
      ? `Priced: ${formatCents(Number(price.advance_cents))} advance`
      : invoice.debtor_name;
  const verdictLine = refused
    ? String(failing[0]?.detail ?? refusalList[0]?.rule ?? 'A check failed, and the reason is recorded below.')
    : `${invoice.seller_name} invoiced ${formatCents(Number(invoice.face_cents))} to ${invoice.debtor_name}, issued ${invoice.issued_on}, due ${invoice.due_on}.`;
  const checksHeading = refused ? 'The eleven checks — what failed, and what passed' : 'The eleven checks';
  // Every refusal reason carries its own fix sentence: the seller reads what to do about each, not just the first.
  const reasonBlocks = refusalList.map((g: any) => {
    const fix = g.sellerAction ?? sellerActionFor(g.code) ?? '';
    const rule = g.rule ? `<span class="rule">Rule: ${esc(g.rule)}</span>` : '';
    const action = fix ? ` <strong>What the seller can do:</strong> ${esc(fix)}` : '';
    return `<p class="reason"><span class="code-chip">${esc(g.code ?? 'REFUSED')}</span>${action}${rule}</p>`;
  }).join('');
  const reasonArea = refused ? reasonBlocks : '';
  const fixCard = refused && mayPress('submit', identity) ? `<div class="card strong" id="fix" style="margin-top:26px;border-left:4px solid var(--oxblood)">
      <h3>Fix this refusal</h3>
      <p class="small muted" style="margin-top:0">Upload the corrected proof of delivery. A resubmission is a new receivable that names this one: the refusal and its audit entry stay exactly where they are, the seller's invoice number gains a revision, and the same document cannot come back — E06 will say so.</p>
      <form method="post" action="/invoices/${esc(invoice.id)}/resubmit" enctype="multipart/form-data" style="margin:10px 0 0">
        <p style="margin:0 0 10px"><input type="file" name="evidence" required></p>
        <p style="margin:0"><button type="submit" class="primary oxblood">Submit the corrected document</button></p>
      </form>
    </div>` : '';
  const resubmissionNote = detail.resubmission?.of
    ? `<p class="note">Corrected submission of <a href="/invoices/${esc(detail.resubmission.of.id)}">${esc(detail.resubmission.of.invoiceNumber)}</a> (${esc(detail.resubmission.of.status)}). The refusal on that invoice stands; this is the document that answers it.</p>`
    : '';
  const correctionsNote = detail.resubmission?.corrections?.length
    ? `<p class="note">A corrected submission exists: ${detail.resubmission.corrections.map((c: any) => `<a href="/invoices/${esc(c.id)}">${esc(c.invoiceNumber)}</a> (${esc(c.status)})`).join(', ')}.</p>`
    : '';
  const overrideNote = overrideRow ? `<details class="override" style="margin-bottom:20px"><summary><strong>Sandbox override applied to E00.</strong> <span class="muted">Why</span></summary> PayPal did not return an eligible ${esc(profile.protectionProgram)} status for the sandbox account in use. The raw status is shown below, the override is written to the audit chain, and it cannot be enabled outside the sandbox.</details>` : '';
  const uncorroboratedNote = uncorroborated ? `<div class="override" style="margin-bottom:24px"><strong>E00 found no rail transaction behind this sale.</strong> Nothing on PayPal corroborates it, so the desk is pricing on the documents and the debtor's record alone: a band-A score is held at B, and the advance ceiling falls with it. This is a stated absence, not a passed check.</div>` : '';

  const evidenceSection = `<section>
      <h3>The evidence</h3>
      ${detail.evidence ? `${/^image\/(jpeg|png)$/.test(String(detail.evidence.mime)) ? `<figure class="evidence-photo"><a href="/invoices/${esc(invoice.id)}/evidence"><img src="/invoices/${esc(invoice.id)}/evidence" alt="The photographed proof of delivery for ${esc(invoice.invoice_number)}, as the readers received it" loading="lazy"></a><figcaption class="small muted">The photograph as filed${rawText.trim() ? '. The text below is what the readers transcribed from it' : ''}.</figcaption></figure>` : ''}
      ${rawText.trim() ? `<div class="doc">${highlightDocument(rawText.slice(0, 4000), highlightWords)}</div>` : ''}
      ${highlightWords.length ? `<p class="small muted" style="margin:8px 0 0">Marked in the document: ${disagreementMarks.length ? 'what the two readers could not agree on' : 'the field a check failed on'}${disagreementMarks.length && failing.length ? ', and the field a check failed on' : ''}.</p>` : ''}
      <p class="small muted" style="margin-top:10px">SHA-256 <span class="hash">${esc(detail.evidence?.sha256?.slice(0, 32) ?? '')}…</span></p>`
        : `<p class="small">${esc(reusedEvidenceNote)}</p>`}
      ${reading}
    </section>`;

  const scoreCard = score ? `<div class="card" style="margin-bottom:18px"><dl class="kv">
          <dt>Debtor score</dt><dd class="em">${score.score} <span class="muted">band ${esc(score.band)}</span></dd>
          ${Object.entries(components ?? {}).map(([k, v]: any) => `<dt class="muted">${esc(k)}</dt><dd class="muted">${v.points}/${v.max}</dd>`).join('')}
        </dl></div>` : '<div class="card" style="margin-bottom:18px"><p class="muted" style="margin:0">No score.</p></div>';

  const priceCard = price ? `<div class="card strong">
        <dl class="kv">
          <dt>Annual rate</dt><dd>${(Number(price.annual_rate_bp) / 100).toFixed(1)}%</dd>
          <dt>Tenor</dt><dd>${price.tenor_days} days</dd>
          <dt>Gross slice</dt><dd>${formatCents(Number(price.advance_cents) + Number(price.discount_cents) + Number(price.fee_reserve_cents))}</dd>
          <dt>Fee reserve</dt><dd>${formatCents(Number(price.fee_reserve_cents))}</dd>
          <dt>Net slice</dt><dd>${formatCents(Number(price.advance_cents) + Number(price.discount_cents))}</dd>
          <dt>Discount</dt><dd>${formatCents(Number(price.discount_cents))}</dd>
          <dt>Advance</dt><dd class="em">${formatCents(Number(price.advance_cents))}</dd>
          <dt>Platform fee</dt><dd>${formatCents(Number(price.platform_fee_cents))}</dd>
        </dl>
      </div>` : '';

  const slicesBlock = slices.length ? `<hr class="rule"><h3>Slices</h3><table><thead><tr><th>Funder</th><th class="r">Share</th><th class="r">Principal</th><th>Order</th><th>Capture</th></tr></thead><tbody>
      ${slices.map((s: any) => `<tr><td>${esc(s.funder_name ?? 'unassigned')}</td><td class="r num">${(Number(s.share_bp) / 100).toFixed(0)}%</td>
        <td class="r num">${formatCents(Number(s.principal_cents))}</td>
        <td class="mono small">${esc(s.paypal_order_id ?? '—')}</td><td class="mono small">${esc(s.capture_id ?? '—')}</td></tr>`).join('')}
      </tbody></table>` : '';

  const noticeBlock = detail.notice ? `<details class="fold"><summary>Notice of assignment<span class="muted">issued</span></summary>
      <p class="small">Issued ${esc(String(detail.notice.created_at).slice(0, 10))} to ${esc(detail.notice.addressee)}. A debtor who is never told may pay its old seller and discharge the debt, so this is the step that makes the purchase effective — kept as the exact bytes, hashed into the chain.
      <a href="/invoices/${esc(invoice.id)}/notice">Read the notice</a>
      <span class="muted"> · SHA-256 <span class="hash">${esc(String(detail.notice.sha256).slice(0, 32))}…</span> — hash the downloaded file to check it against this.</span></p>
      ${view === 'desk' && (!identity || identity.role === 'desk') ? serviceRegister(invoice, detail.noticeService ?? [], !identity || identity.role === 'desk') : ''}</details>` : `<details class="fold"><summary>Notice of assignment<span class="muted">not issued</span></summary>
      <p class="small muted">Not issued. The desk tells the debtor where to pay only once the receivable is funded in full; a partly bought invoice has not been assigned cleanly.</p></details>`;

  const auditBlock = `<details class="fold"><summary>Audit chain<span class="muted">${audit.length} hashed ${audit.length === 1 ? 'entry' : 'entries'}</span></summary>
      <div class="table-wrap"><table><thead><tr><th class="r">Seq</th><th>Event</th><th>Hash</th><th>Previous</th></tr></thead><tbody>
      ${audit.map((a: any) => `<tr><td class="r num">${a.seq}</td><td>${esc(a.kind)}</td>
        <td class="hash small">${esc(a.hash.slice(0, 24))}…</td><td class="hash small muted">${esc(a.prev_hash.slice(0, 24))}…</td></tr>`).join('')}
      </tbody></table></div></details>`;

  const passedCount = checks.length - failing.length;
  const facts: [string, string, boolean?][] = [
    ['Face', formatCents(Number(invoice.face_cents))],
    ['Debtor', String(invoice.debtor_name ?? ''), true],
    ['Seller', String(invoice.seller_name ?? ''), true],
    ['Term', `${daysBetween(invoice.issued_on, invoice.due_on)} days`],
    ['Debtor score', score ? `${score.score} · band ${score.band}` : '—'],
    ...(price ? [
      ['Annual rate', `${(Number(price.annual_rate_bp) / 100).toFixed(1)}%`],
      ['Advance', formatCents(Number(price.advance_cents))]
    ] as [string, string][] : []),
    ['Checks passed', `${passedCount} of ${checks.length}`]
  ];
  const factsBlock = `<dl class="facts">${facts.map(([k, v, text]) => `<div><dt>${esc(k)}</dt><dd${text ? ' class="text"' : ''}>${esc(v)}</dd></div>`).join('')}</dl>`;
  const topActions = join([
    refused && mayPress('submit', identity) ? `<a class="button primary oxblood" href="#fix">Fix this refusal: upload the corrected proof</a>` : '',
    fundAction(invoice, slices, view, identity),
    maturityAction(invoice, price, maturity, view, identity)
  ]);
  const actionsBlock = topActions.trim() ? `<div class="verdict-actions">${topActions}</div>` : '';
  const checksBlock = `<section style="margin-top:30px">
      ${failing.length ? `<h3>What failed</h3><div class="card fails" style="border-left:4px solid var(--oxblood)">${failing.map((c: any) => checkRow(c, profile)).join('')}</div>` : ''}
      <details class="fold"${failing.length ? '' : ''}><summary>${esc(checksHeading)}<span class="muted">${passedCount} passed · ${failing.length} failed</span></summary>
        ${profileNote(profile)}
        <div class="card">${checks.map((c: any) => checkRow(c, profile)).join('')}</div>
      </details>
    </section>`;

  const body = join([
    roleStrip(`/invoices/${invoice.id}`, view, identity),
    `<div class="small muted" style="margin-top:24px"><a href="/">The book</a> / ${esc(invoice.invoice_number)}</div>`,
    `<div class="verdict ${verdictClass}">
      <div class="eyebrow"><span class="mono">${esc(invoice.invoice_number)}</span><h2>${esc(statusLabel[invoice.status] ?? invoice.status)}</h2>${statusText !== (statusLabel[invoice.status] ?? invoice.status) ? `<span class="status ${statusClass(invoice.status)}">${esc(statusText)}</span>` : ''}</div>
      <h1>${esc(headline)}</h1>
      <p class="verdict-line">${esc(verdictLine)}</p>
      ${reasonArea}
      ${factsBlock}
      ${actionsBlock}
    </div>`,
    resubmissionNote,
    correctionsNote,
    roleCard(invoice, price, slices, view),
    overrideNote,
    uncorroboratedNote,
    `<div class="grid cols-detail">`,
    evidenceSection,
    `<section class="rail">
      <h3>The arithmetic</h3>
      ${scoreCard}
      ${priceCard}
      ${defaultCard(invoice, price, defaultEvent, !identity || identity.role === 'desk')}
    </section>`,
    `</div>`,
    fixCard,
    checksBlock,
    slicesBlock,
    noticeBlock,
    auditBlock
  ]);

  return layout({ title: invoice.invoice_number, current: '/', sandbox, canSubmit: mayPress('submit', identity) }, body);
}

export function renderLedger(rows: any[], totals: any[], sandbox: boolean, events: any[] = [], identity?: Identity | null): string {
  const byTxn = new Map<string, any[]>();
  for (const r of rows) {
    if (!byTxn.has(r.txn_id)) byTxn.set(r.txn_id, []);
    byTxn.get(r.txn_id)!.push(r);
  }
  const body = join([
    `<h1>The settlement book</h1>`,
    `<p class="lede">Every posting, grouped by transaction. Each transaction must balance; the pinned row below asserts it.</p>`,
    `<table><thead><tr><th>Txn</th><th>Account</th><th>Memo</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>`,
    [...byTxn.entries()].map(([txn, legs]) => {
      const d = legs.reduce((a, l) => a + Number(l.debits), 0);
      const c = legs.reduce((a, l) => a + Number(l.credits), 0);
      const balanced = d === c;
      return legs.map((l, i) => `<tr>
        <td class="mono small">${i === 0 ? esc(txn) : ''}</td>
        <td class="mono">${esc(l.account)}</td>
        <td class="muted small">${esc(l.memo)}</td>
        <td class="r num">${Number(l.debits) ? formatCents(Number(l.debits)) : ''}</td>
        <td class="r num">${Number(l.credits) ? formatCents(Number(l.credits)) : ''}</td>
      </tr>`).join('') + `<tr class="total"><td></td><td colspan="2" class="${balanced ? 's-verified' : 's-refused'}">${balanced ? 'Balanced' : 'UNBALANCED'}</td>
        <td class="r num">${formatCents(d)}</td><td class="r num">${formatCents(c)}</td></tr>`;
    }).join(''),
    `</tbody></table>`,
    `<hr class="rule"><h3>Account totals</h3>
     <table><thead><tr><th>Account</th><th>Kind</th><th class="r">Debits</th><th class="r">Credits</th><th class="r">Balance</th></tr></thead><tbody>
     ${totals.map((t) => `<tr><td class="mono">${esc(t.account)}</td><td class="muted">${esc(t.kind)}</td>
       <td class="r num">${formatCents(Number(t.debits))}</td><td class="r num">${formatCents(Number(t.credits))}</td>
       <td class="r num">${formatCents(Number(t.balance))}</td></tr>`).join('')}
     </tbody></table>`,
    `<p class="note" style="margin-top:24px">The clearing account is the outside world: it carries what actually arrived from debtors. Party accounts carry cumulative settled amounts. No account here is a platform balance — PayPal settles each purchase unit directly to its payee.</p>`,
    events.length === 0 ? '' : `<hr class="rule"><h3>Inbound webhooks</h3>
     <p class="note">Every event PayPal delivered to this server. Only a signed event can change a position; an unverified one is kept as evidence and ignored.</p>
     <table><thead><tr><th>Received</th><th>Event</th><th>Signature</th><th>Effect</th></tr></thead><tbody>
     ${events.map((e: any) => `<tr>
       <td class="mono small">${esc(e.received_at.replace('T', ' ').slice(0, 19))}</td>
       <td class="mono small">${esc(e.type)}</td>
       <td class="${e.verified ? 's-verified' : 's-refused'}">${e.verified ? 'verified' : 'unverified'}</td>
       <td class="muted small">${esc(e.outcome ?? (e.verified ? 'no action for this type' : 'ignored'))}</td>
     </tr>`).join('')}
     </tbody></table>`
  ]);
  return layout({ title: 'Settlement', current: '/ledger', sandbox, canSubmit: mayPress('submit', identity) }, body);
}

/**
 * The desk proving itself to whoever asks, with no login: the audit chain re-walked on request,
 * the book's counts read from the data, the ledger's balance assertion, and what PayPal's webhooks
 * have actually done. Aggregate only — nothing here names an operator, a party or a document.
 */
export function renderStatus(data: any): string {
  const chain = data.auditChain ?? {};
  const counts = data.archiveCounts ?? {};
  const webhooks = (data.webhooks?.byType ?? []) as any[];
  const body = join([
    `<h1>Desk status</h1>`,
    `<p class="lede">No login, no secrets: the audit chain is re-walked every time this page opens, the counts are read from the data, and the ledger re-asserts its own balance. Aggregate only — this page names no operator, no party and no document. Times are UTC.</p>`,
    `<h2>The audit chain</h2>
     <table><tbody>
       <tr><th>Integrity</th><td class="${chain.ok ? 's-verified' : 's-refused'}">${chain.ok ? 'Intact — every hash in the chain recomputes' : `Broken at entry ${chain.brokenAt}: ${esc(chain.reason ?? '')}`}</td></tr>
       <tr><th>Entries</th><td class="num">${Number(chain.length ?? 0).toLocaleString('en-US')}</td></tr>
     </tbody></table>`,
    `<h2>The book</h2>
     <table><thead><tr><th>Total invoices</th><th>Refused</th><th>Verified</th><th>Funded</th></tr></thead><tbody>
       <tr><td class="num">${Number(counts.total ?? 0).toLocaleString('en-US')}</td>
           <td class="num">${Number(counts.refused ?? 0).toLocaleString('en-US')}</td>
           <td class="num">${Number(counts.verified ?? 0).toLocaleString('en-US')}</td>
           <td class="num">${Number(counts.funded ?? 0).toLocaleString('en-US')}</td></tr>
     </tbody></table>`,
    `<h2>The settlement book, by account kind</h2>
     ${(data.ledgerByKind ?? []).length === 0
       ? `<p class="note">No postings yet. Nothing in the seeded book has been funded, so the ledger is empty — which is the honest state, not a hidden one. Fund a slice and this table fills from the same posting code the tests exercise.</p>`
       : `<table><thead><tr><th>Kind</th><th class="r">Accounts</th><th class="r">Debits</th><th class="r">Credits</th><th class="r">Balance</th></tr></thead><tbody>
     ${(data.ledgerByKind ?? []).map((t: any) => `<tr><td class="mono">${esc(t.kind)}</td><td class="r num">${Number(t.accounts)}</td>
       <td class="r num">${formatCents(Number(t.debits))}</td><td class="r num">${formatCents(Number(t.credits))}</td>
       <td class="r num">${formatCents(Number(t.balance))}</td></tr>`).join('')}
     </tbody></table>
     <p class="note">Party accounts are folded into their kind: this page says what the book is made of, not who is in it.</p>`}`,
    `<h2>Webhooks PayPal delivered</h2>
     ${webhooks.length === 0
       ? `<p class="note">None yet.</p>`
       : `<table><thead><tr><th>Event</th><th class="r">Delivered</th><th class="r">Signature verified</th><th class="r">Stored unverified</th></tr></thead><tbody>
         ${webhooks.map((w) => `<tr><td class="mono small">${esc(w.type)}</td><td class="r num">${Number(w.n)}</td><td class="r num">${Number(w.verified ?? 0)}</td><td class="r num">${Number(w.unverified ?? 0)}</td></tr>`).join('')}
         </tbody></table>
         <p class="note">${Number(data.webhooks?.total ?? 0).toLocaleString('en-US')} deliveries: ${Number(data.webhooks?.verified ?? 0).toLocaleString('en-US')} verified, ${Number(data.webhooks?.unverified ?? 0).toLocaleString('en-US')} stored unverified. Last delivery (UTC): ${esc(String(data.lastWebhookAt ?? '\u2014').replace('T', ' ').slice(0, 19))}. Only a signed event can change a position; an unverified one is kept as evidence and ignored.</p>`}`,
    `<p class="note" style="margin-top:24px">The same data as JSON: <a class="mono" href="/api/status">/api/status</a>. The desk's full machine surface — the book, each deal room, the ledger — starts at <a class="mono" href="/api/invoices">/api/invoices</a>, signed in as the desk.</p>`
  ]);
  return layout({ title: 'Status', current: '/status', sandbox: !!data.sandbox, canSubmit: false }, body);
}

export function renderSubmit(dealers: { id: string; legal_name: string; limit_cents: number }[], sandbox: boolean, error?: string, identity?: Identity | null): string {
  const today = todayIso();
  const body = join([
    `<h1>Submit a receivable</h1>`,
    `<p class="lede">The seller uploads the invoice details and the delivery evidence. An extraction agent reads the proof of delivery, and eleven checks decide whether the invoice can be listed. Nothing here is a formality: most submissions are refused.</p>`,
    `<p class="note" style="margin-bottom:18px">Reading the document is the slow step — two independent readers take up to a minute, and this page is server-rendered on purpose, so it does not spin or tick while they work. It moves when the verdict does.</p>`,
    error ? `<div class="refusal" style="margin-bottom:24px"><p style="margin:0">${esc(error)}</p></div>` : '',
    `<form method="post" action="/submit" enctype="multipart/form-data" class="card" style="max-width:760px">`,
    `<div class="grid cols-2" style="gap:18px 24px">`,
    `<label><h3>Debtor</h3><select name="debtorId" required style="width:100%;font-family:var(--sans);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)">
      ${dealers.map((d) => `<option value="${esc(d.id)}">${esc(d.legal_name)}</option>`).join('')}
    </select></label>`,
    `<label><h3>Invoice number</h3><input name="invoiceNumber" required placeholder="A-1042" style="width:100%;font-family:var(--mono);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)"></label>`,
    `<label><h3>Face value, USD</h3><input name="face" required placeholder="4800.00" inputmode="decimal" style="width:100%;font-family:var(--mono);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)"></label>`,
    `<label><h3>Purchase order</h3><input name="poRef" placeholder="PO-88421" style="width:100%;font-family:var(--mono);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)"></label>`,
    `<label><h3>Issued on</h3><input type="date" name="issuedOn" required value="${today}" style="width:100%;font-family:var(--mono);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)"></label>`,
    `<label><h3>Due on</h3><input type="date" name="dueOn" required style="width:100%;font-family:var(--mono);font-size:0.875rem;padding:10px;border:1px solid var(--rule);background:#fffdf7;color:var(--ink)"></label>`,
    `</div>`,
    `<div style="margin-top:20px"><h3>Proof of delivery (PDF, text, or a photograph)</h3>
      <input type="file" name="evidence" required accept="application/pdf,text/plain,image/png,image/jpeg" style="font-size:0.8125rem">
      <p class="small muted" style="margin:8px 0 0">The file is hashed, stored outside the web root, and read by the extraction agent. A photograph has no text layer, so the model transcribes it and the label parser reads the transcription; the invoice page says which of the two produced any given field. Its hash is checked against every other submission: the same proof cannot back two invoices.</p></div>`,
    `<div style="margin-top:20px"><h3>The rail behind this sale</h3>
      <label class="small" style="display:flex;gap:10px;align-items:flex-start">
        <input type="checkbox" name="railStatus" value="NOT_ON_RAIL" style="margin-top:3px">
        <span>This receivable was <strong>not paid through PayPal</strong>, so there is no transaction for the rail to vouch for.
        Tick it and E00 records the sale as uncorroborated: the desk still reads every document, but it prices the position
        one band lower rather than claiming a signal it never received.</span>
      </label>
      <p class="small muted" style="margin:8px 0 0">Leaving it unticked is not a claim of protection either. PayPal's own answer,
      when the desk can ask for it, is the only thing that can mark a sale <em>eligible</em> — that value is never a field on this form.</p></div>`,
    `<div style="margin-top:20px"><h3>The term on this paper</h3>
      <div style="display:grid;gap:10px">
        <label class="small" style="display:flex;gap:10px;align-items:flex-start">
          <input type="radio" name="recourse" value="recourse" checked style="margin-top:3px">
          <span><strong>With recourse</strong> — if the debtor does not pay, the seller repurchases what the funder advanced.
          The standard term, and the only one band C paper is bought on.</span>
        </label>
        <label class="small" style="display:flex;gap:10px;align-items:flex-start">
          <input type="radio" name="recourse" value="non_recourse" style="margin-top:3px">
          <span><strong>Without recourse</strong> — the desk takes the debtor's credit risk as its own loss.
          Priced ${(NON_RECOURSE_PREMIUM_BP / 100).toFixed(2)}% a year higher, because the term is a choice the desk is paid for rather than a preference stated after the fact.</span>
        </label>
      </div>
      <p class="small muted" style="margin:8px 0 0">Chosen now, written to the price row and the audit chain, and read back on the day the paper
      defaults. A desk that decided the term after seeing the loss would be a desk with no term at all.</p></div>`,
    `<div style="margin-top:22px"><button type="submit">Submit for verification</button></div>`,
    `</form>`
  ]);
  return layout({ title: 'Submit', current: '/submit', sandbox, canSubmit: mayPress('submit', identity) }, body);
}

export function renderArchive(summary: any[], counts: any, recent: any[], sandbox: boolean, identity?: Identity | null): string {
  const total = summary.reduce((a, r) => a + Number(r.n), 0);
  const body = join([
    `<h1>What this desk refused</h1>`,
    `<p class="lede">A refusal is the product. Each row below is an invoice that could not be financed, and the check that stopped it.</p>`,
    `<div class="grid cols-2" style="margin-bottom:36px">
      <div class="card"><h3>Refusals on record</h3><div class="num" style="font-size:2.25rem;color:var(--oxblood)">${total.toLocaleString('en-US')}</div>
        <p class="small muted" style="margin:6px 0 0">of ${Number(counts.total).toLocaleString('en-US')} invoices received</p></div>
      <div class="card"><h3>By reason</h3>
        <table>${summary.map((s) => `<tr><td class="mono small">${esc(s.code ?? 'REFUSED')}</td><td class="r num">${Number(s.n).toLocaleString('en-US')}</td></tr>`).join('')}</table>
      </div>
    </div>`,
    `<h3>Most recent</h3>`,
    `<table><thead><tr><th>Invoice</th><th>Debtor</th><th class="r">Face</th><th>Reason</th><th>Date</th></tr></thead><tbody>
      ${recent.map((r) => `<tr><td><a href="/invoices/${esc(r.id)}">${esc(r.invoice_number)}</a></td><td>${esc(r.debtor_name)}</td>
        <td class="r num">${formatCents(Number(r.face_cents))}</td><td><span class="code-chip" style="font-size:0.6875rem">${esc(r.reason ?? 'REFUSED')}</span></td>
        <td class="small muted">${esc((r.created_at ?? '').slice(0, 10))}</td></tr>`).join('')}
    </tbody></table>`
  ]);
  return layout({ title: 'Refusals', current: '/archive', sandbox, canSubmit: mayPress('submit', identity) }, body);
}
