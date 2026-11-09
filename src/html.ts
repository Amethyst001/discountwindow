export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function raw(html: string): { toString(): string; __raw: true } {
  return { toString: () => html, __raw: true } as any;
}

export function join(parts: unknown[]): string {
  return parts.map((p) => String(p ?? '')).join('');
}

const TOKENS = `
  --paper: #f4efe4;
  --paper-2: #ebe4d5;
  --ink: #191712;
  --ink-2: #4a453c;
  --ink-3: #6b6357;
  --rule: #cfc5b2;
  --oxblood: #78211f;
  --olive: #40532a;
  --gold: #7d5a10;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
`;

export const STYLES = `
:root {${TOKENS}}
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 0.9375rem;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--rule); }
a:hover { border-bottom-color: var(--ink); }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 28px 96px; }
.masthead { border-bottom: 1px solid var(--ink); margin-bottom: 0; }
.masthead .inner { max-width: 1180px; margin: 0 auto; padding: 20px 28px 16px; display: flex; align-items: baseline; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.wordmark { font-family: var(--serif); font-size: 1.375rem; letter-spacing: -0.01em; border: 0; }
.wordmark small { font-family: var(--serif); font-style: italic; font-size: 0.875rem; color: var(--ink-3); margin-left: 12px; }
nav.top { display: flex; gap: 22px; font-size: 0.875rem; font-weight: 500; }
nav.top a { border: 0; color: var(--ink-2); }
nav.top a[aria-current="page"] { color: var(--ink); border-bottom: 2px solid var(--ink); }
.rule-strip { border-bottom: 1px solid var(--rule); }
h1 { font-family: var(--serif); font-weight: 500; font-size: 2.25rem; line-height: 1.15; letter-spacing: -0.015em; margin: 40px 0 8px; }
h2 { font-family: var(--serif); font-weight: 500; font-size: 1.25rem; margin: 0 0 12px; letter-spacing: -0.01em; }
h3 { font-family: var(--serif); font-size: 1.0625rem; letter-spacing: 0; color: var(--ink); font-weight: 600; margin: 0 0 10px; }
p.lede { font-size: 1.0625rem; color: var(--ink-2); max-width: 62ch; margin: 0 0 32px; }
.rule { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
.money, .num, time, code, .hash { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-3); }
.small { font-size: 0.8125rem; }
.card { background: #faf7ef; border: 1px solid var(--rule); box-shadow: 3px 3px 0 rgba(25,23,18,0.06); padding: 22px 24px; }
.grid { display: grid; gap: 24px; }
.cols-3 { grid-template-columns: minmax(0,1.15fr) minmax(0,1.1fr) minmax(0,0.9fr); }
.cols-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
.message-page { max-width: 680px; margin: 48px 0; padding: 28px 32px; background: var(--card, #fbf8f1); border: 1px solid rgba(25,23,18,.18); border-left: 4px solid var(--gold); }
.message-page.refuse { border-left-color: var(--oxblood); }
.message-page h2 { margin: 0 0 12px; }
.message-page p { max-width: 60ch; }
.message-page pre { white-space: pre-wrap; }
.message-back { margin-top: 20px; }
tr.current td { background: rgba(120,33,31,.06); }
@media (max-width: 980px) { .cols-3, .cols-2 { grid-template-columns: minmax(0,1fr); } }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th { text-align: left; font-size: 0.75rem; letter-spacing: 0.02em; color: var(--ink-2); font-weight: 600; padding: 0 12px 8px 0; border-bottom: 1px solid var(--ink); }
td { padding: 12px 12px 12px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.r, th.r { text-align: right; padding-right: 0; }
td.r + td:not(.r), th.r + th:not(.r), td.num + td, th.num + th { padding-left: 18px; }
tr.total td { border-top: 1px solid var(--ink); border-bottom: 0; font-weight: 600; padding-top: 14px; }
.status { font-size: 0.8125rem; font-weight: 600; white-space: nowrap; }
.s-refused { color: var(--oxblood); }
.s-verified, .s-funded, .s-settled, .s-repurchased { color: var(--olive); }
.s-listed, .s-scored, .s-priced, .s-matured, .s-partially_funded { color: var(--gold); }
.s-received, .s-extracting { color: var(--ink-3); }
.s-overdue, .s-disputed, .s-defaulted { color: var(--oxblood); }
.badge { display: inline-block; border: 1px solid currentColor; padding: 1px 7px; font-size: 0.625rem; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; }
.check { display: grid; grid-template-columns: 26px minmax(0,1fr); gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--rule); }
.check:last-child { border-bottom: 0; }
.check .mark { font-family: var(--mono); font-size: 0.8125rem; line-height: 1.6; }
.check .pass .mark, .check.pass .mark { color: var(--olive); }
.check.fail .mark { color: var(--oxblood); }
.check .rule-text { color: var(--ink-2); font-size: 0.875rem; }
.check .detail { font-size: 0.875rem; }
.check.fail .detail { color: var(--oxblood); }
.refusal { border: 1px solid var(--oxblood); background: #fbf3ef; box-shadow: 4px 4px 0 rgba(120,33,31,0.12); padding: 20px 22px; }
.refusal h2 { color: var(--oxblood); }
.verdict { border: 1px solid var(--rule); border-left: 4px solid var(--ink); background: #faf7ef; box-shadow: 4px 4px 0 rgba(25,23,18,0.07); padding: 26px 28px 24px; margin: 16px 0 26px; }
.verdict h2 { font-family: var(--sans); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 10px; }
.verdict.is-refused h2 { color: var(--oxblood); }
.verdict.is-priced h2 { color: var(--gold); }
.verdict.is-funded h2 { color: var(--olive); }
.verdict .eyebrow { display: flex; align-items: center; gap: 14px; font-size: 0.6875rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); }
.verdict h1 { margin: 12px 0 6px; font-size: 2.5rem; line-height: 1.08; }
.verdict-line { margin: 0; font-size: 1.0625rem; color: var(--ink-2); max-width: 72ch; }
.verdict.is-refused { border-left-color: var(--oxblood); background: #fbf3ef; }
.verdict.is-refused h1 { color: var(--oxblood); }
.verdict.is-priced { border-left-color: var(--gold); }
.verdict.is-funded { border-left-color: var(--olive); }
.cols-detail { grid-template-columns: minmax(0,1.55fr) minmax(0,0.95fr); }
@media (max-width: 980px) { .cols-detail { grid-template-columns: minmax(0,1fr); } }
.rail { position: sticky; top: 22px; align-self: start; }
@media (max-width: 980px) { .rail { position: static; } }
.card.strong { box-shadow: 5px 5px 0 rgba(25,23,18,0.1); border-color: #ddd5c2; }
tbody tr:hover td { background: rgba(25,23,18,0.025); }
button, input[type="submit"] { font-family: var(--sans); font-size: 0.8125rem; letter-spacing: 0.04em; background: var(--ink); color: var(--paper); border: 0; padding: 10px 18px; cursor: pointer; box-shadow: 3px 3px 0 rgba(25,23,18,0.16); }
button:hover { background: #2b2823; }
button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--ink); box-shadow: none; }
.code-chip { font-family: var(--mono); font-size: 0.75rem; border: 1px solid var(--oxblood); color: var(--oxblood); padding: 2px 8px; display: inline-block; }
.doc { border: 1px solid var(--rule); background: #fffdf7; padding: 20px 22px; font-family: var(--mono); font-size: 0.75rem; line-height: 1.9; white-space: pre-wrap; word-break: break-word; }
.evidence-photo { margin: 0 0 12px; }
.evidence-photo img { display: block; max-width: 100%; height: auto; border: 1px solid var(--rule); background: #fffdf7; }
.evidence-photo a { border: 0; }
.evidence-photo figcaption { margin-top: 6px; }
.doc mark { background: #f2d9d6; color: var(--oxblood); padding: 0 2px; }
.doc .hl { background: #e9dfc2; }
tr.diff td { background: #fbf3ef; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; font-size: 0.8125rem; }
.kv dt { color: var(--ink-3); }
.kv dd { margin: 0; text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.kv dd.em { font-weight: 600; }
button, .button { font-family: var(--sans); font-size: 0.875rem; letter-spacing: 0.01em; font-weight: 600; background: var(--ink); color: var(--paper); border: 1px solid var(--ink); padding: 11px 18px; cursor: pointer; box-shadow: 3px 3px 0 rgba(25,23,18,0.18); }
button:hover, .button:hover { background: #000; }
button:disabled { background: var(--paper-2); color: var(--ink-3); border-color: var(--rule); box-shadow: none; cursor: not-allowed; }
button.ghost { background: transparent; color: var(--ink); }
button.danger { background: var(--oxblood); border-color: var(--oxblood); }
:focus-visible { outline: 3px solid var(--oxblood); outline-offset: 3px; }
a:focus-visible { border-bottom-color: transparent; }
.note { border-left: 2px solid var(--gold); padding: 2px 0 2px 14px; font-size: 0.8125rem; color: var(--ink-2); }
.override { border: 1px dashed var(--gold); background: #fbf6e8; padding: 12px 14px; font-size: 0.8125rem; }
footer { border-top: 1px solid var(--rule); margin-top: 64px; padding-top: 18px; font-size: 0.75rem; color: var(--ink-3); display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.empty { padding: 48px 0; color: var(--ink-3); font-family: var(--serif); font-size: 1.125rem; }
.role-strip { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 0.8125rem; color: var(--ink-3); border-bottom: 1px solid var(--rule); padding: 12px 0; margin-top: 24px; }
.role-strip a { border: 0; padding: 2px 8px; color: var(--ink-2); }
.role-strip a.on { background: var(--ink); color: var(--paper); }
@media (max-width: 640px) {
  .wrap { padding: 0 18px 64px; }
  .masthead .inner { padding: 16px 18px 14px; }
  h1 { font-size: 1.75rem; margin-top: 28px; }
  nav.top { gap: 14px; font-size: 0.6875rem; }
  th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
}
/* UI pass (Nov 9): decision first, details on demand */
.verdict { padding: 24px 28px 22px; margin: 14px 0 20px; }
.verdict .eyebrow { font-size: 0.8125rem; letter-spacing: 0.02em; }
.verdict .eyebrow .mono { font-family: var(--mono); }
.verdict .eyebrow h2 { margin: 0; font-size: 0.8125rem; letter-spacing: 0.08em; }
.verdict h1 { margin: 8px 0 6px; font-size: 2.25rem; }
.verdict .reason { margin: 12px 0 0; font-size: 0.9375rem; }
.verdict .reason .rule { display: block; margin: 6px 0 0; border: 0; color: var(--ink-3); font-size: 0.8125rem; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 12px 20px; margin: 18px 0 0; padding: 14px 0 0; border-top: 1px solid var(--rule); }
.facts div { min-width: 0; }
.facts dt { font-size: 0.75rem; color: var(--ink-3); margin: 0 0 2px; }
.facts dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 0.9375rem; font-weight: 600; overflow-wrap: anywhere; }
.facts dd.text { font-family: var(--sans); font-weight: 500; }
.verdict-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin: 18px 0 0; }
.verdict-actions > div { margin-top: 0 !important; }
.button.primary, button.primary { font-size: 0.9375rem; padding: 14px 24px; letter-spacing: 0.03em; }
.button.oxblood, button.oxblood { background: var(--oxblood); border-color: var(--oxblood); color: #fff; box-shadow: 3px 3px 0 rgba(120,33,31,0.22); }
.button.oxblood:hover, button.oxblood:hover { background: #5e1817; }
a.button { display: inline-block; border-bottom: 1px solid var(--ink); text-decoration: none; }
a.button.oxblood { border-bottom-color: var(--oxblood); }
details.fold { margin-top: 18px; border-top: 1px solid var(--rule); }
details.fold > summary { cursor: pointer; list-style: none; padding: 14px 0; font-family: var(--serif); font-size: 1.125rem; font-weight: 600; display: flex; align-items: baseline; gap: 4px; }
details.fold > summary::after { margin-left: auto; }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary::after { content: "Show"; font-family: var(--sans); font-size: 0.8125rem; font-weight: 500; color: var(--ink-2); border-bottom: 1px solid var(--rule); }
details.fold[open] > summary::after { content: "Hide"; }
details.fold > summary .muted { font-family: var(--sans); font-size: 0.8125rem; font-weight: 400; margin-left: 8px; }
details.fold > summary:hover::after { border-bottom-color: var(--ink); }
details.override { padding: 10px 14px; }
details.override > summary { cursor: pointer; }
.fails .check { border-bottom: 0; }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 14px; }
.tabs a { border: 1px solid var(--rule); padding: 6px 12px; font-size: 0.8125rem; color: var(--ink-2); background: #faf7ef; }
.tabs a:hover { border-color: var(--ink); }
.tabs a[aria-current="page"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.tabs .count { font-family: var(--mono); font-size: 0.75rem; margin-left: 6px; opacity: 0.85; }
.toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin: 8px 0 12px; }
.search { display: flex; gap: 8px; }
.search input { font-family: var(--sans); font-size: 0.875rem; padding: 9px 12px; border: 1px solid var(--rule); background: #fffdf7; color: var(--ink); min-width: 240px; }
.search button { padding: 9px 14px; font-size: 0.8125rem; text-transform: none; letter-spacing: 0; box-shadow: none; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 16px 0 0; font-size: 0.875rem; flex-wrap: wrap; }
.pager a { border: 1px solid var(--ink); padding: 7px 14px; }
.pager .off { border: 1px solid var(--rule); padding: 7px 14px; color: var(--ink-3); }
.examples { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 12px; margin: 12px 0 0; padding: 0; list-style: none; }
.examples li a { display: block; height: 100%; border: 1px solid var(--rule); border-top: 3px solid var(--ink); background: #fffdf7; padding: 12px 14px; }
.examples li a:hover { border-color: var(--ink); }
.examples li.ex-refused a { border-top-color: var(--oxblood); }
.examples li.ex-priced a { border-top-color: var(--gold); }
.examples .num-id { font-family: var(--mono); font-weight: 600; font-size: 0.9375rem; display: block; }
.examples .tag { font-size: 0.75rem; font-weight: 600; display: block; margin: 2px 0 6px; }
.examples .why { font-size: 0.8125rem; color: var(--ink-2); display: block; line-height: 1.45; }
@media (max-width: 980px) { .examples { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (max-width: 640px) {
  .wordmark small { display: none; }
  nav.top { gap: 16px; font-size: 0.8125rem; overflow-x: auto; max-width: 100%; }
  .verdict { padding: 18px 18px 16px; }
  .verdict h1 { font-size: 1.75rem; }
  .facts { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .examples { grid-template-columns: minmax(0,1fr); }
  .search input { min-width: 0; width: 100%; }
  .search { width: 100%; }
  .stat-cards { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }
  th:nth-child(5), td:nth-child(5), th:nth-child(7), td:nth-child(7) { display: none; }
  .doc { padding: 14px; }
}
/* Round 5: plain labels, priced waterfall, visible held actions, status tiles */
.held { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-top: 18px; }
.held .note { margin: 0; max-width: 46ch; }
.verdict-actions .held { margin-top: 0; }
button.primary:disabled { background: #e6dfcf; color: #5a5348; border: 1px dashed #8f8676; box-shadow: none; }
.card-k { font-family: var(--sans); font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); margin: 0 0 10px; }
.kv dt .why { display: block; font-size: 0.75rem; color: var(--ink-3); line-height: 1.35; }
.waterfall dt { color: var(--ink); }
.waterfall dt.total, .waterfall dd.total { border-top: 1px solid var(--rule); padding-top: 6px; }
.waterfall dd { align-self: start; }
a.card.stat { display: block; border-bottom: 1px solid var(--rule); transition: border-color .12s, transform .12s; }
a.card.stat:hover { border-color: var(--ink); transform: translate(-1px,-1px); }
.status-tiles { display: grid; grid-template-columns: 1.5fr repeat(4, minmax(0,1fr)); gap: 16px; margin: 8px 0 36px; }
.status-tiles .stat h3 { margin-bottom: 6px; }
.status-tiles .big { font-size: 1.75rem; font-family: var(--mono); font-variant-numeric: tabular-nums; line-height: 1.2; }
.status-tiles .stat p { margin: 6px 0 0; }
.status-tiles .stat.ok { border-left: 4px solid var(--olive); }
.status-tiles .stat.bad { border-left: 4px solid var(--oxblood); }
main h2 { margin-top: 28px; }
@media (max-width: 980px) { .status-tiles { grid-template-columns: repeat(2, minmax(0,1fr)); } .status-tiles .stat.ok, .status-tiles .stat.bad { grid-column: 1 / -1; } }
@media (prefers-reduced-motion: reduce) { a.card.stat { transition: none; } a.card.stat:hover { transform: none; } }
`;

export interface LayoutOptions {
  title: string;
  current: string;
  sandbox: boolean;
  /** False hides the Submit link: a name that cannot upload should not be shown the door to it. */
  canSubmit?: boolean;
}

export function layout(opts: LayoutOptions, body: string): string {
  const nav = ([
    ['/', 'The Book'],
    ['/submit', 'Submit'],
    ['/archive', 'Refusals'],
    ['/ledger', 'Settlement'],
    ['/status', 'Status']
  ] as const).filter(([href]) => href !== '/submit' || opts.canSubmit !== false);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · The Discount Window</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/favicon-192.png">
<style>${STYLES}</style>
</head>
<body>
<header class="masthead">
  <div class="inner">
    <a class="wordmark" href="/">The Discount Window<small>Receivables, gated on proof</small></a>
    <nav class="top">
      ${nav.map(([href, label]) => `<a href="${href}"${opts.current === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
  </div>
</header>
<div class="rule-strip"></div>
<main class="wrap">
${body}
<footer>
  <span>${opts.sandbox ? 'PayPal sandbox. No real money moves. Every payment here was captured against api-m.sandbox.paypal.com.' : 'Live configuration.'}</span>
  <span class="mono small">Nothing is listed until delivery evidence is verified.</span>
</footer>
</main>
</body>
</html>`;
}
