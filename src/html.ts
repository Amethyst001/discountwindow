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
  --ink-3: #7a7266;
  --rule: #cfc5b2;
  --oxblood: #78211f;
  --olive: #40532a;
  --gold: #9a6f16;
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
.wordmark small { font-family: var(--sans); font-size: 0.6875rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-left: 12px; }
nav.top { display: flex; gap: 22px; font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; }
nav.top a { border: 0; color: var(--ink-2); }
nav.top a[aria-current="page"] { color: var(--ink); border-bottom: 1px solid var(--ink); }
.rule-strip { border-bottom: 1px solid var(--rule); }
h1 { font-family: var(--serif); font-weight: 500; font-size: 2.25rem; line-height: 1.15; letter-spacing: -0.015em; margin: 40px 0 8px; }
h2 { font-family: var(--serif); font-weight: 500; font-size: 1.25rem; margin: 0 0 12px; letter-spacing: -0.01em; }
h3 { font-size: 0.6875rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; margin: 0 0 10px; }
p.lede { font-size: 1.0625rem; color: var(--ink-2); max-width: 62ch; margin: 0 0 32px; }
.rule { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
.money, .num, time, code, .hash { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-3); }
.small { font-size: 0.8125rem; }
.card { background: #faf7ef; border: 1px solid var(--rule); box-shadow: 3px 3px 0 rgba(25,23,18,0.06); padding: 22px 24px; }
.grid { display: grid; gap: 24px; }
.cols-3 { grid-template-columns: minmax(0,1.15fr) minmax(0,1.1fr) minmax(0,0.9fr); }
.cols-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
@media (max-width: 980px) { .cols-3, .cols-2 { grid-template-columns: minmax(0,1fr); } }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th { text-align: left; font-size: 0.6875rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; padding: 0 12px 8px 0; border-bottom: 1px solid var(--ink); }
td { padding: 12px 12px 12px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.r, th.r { text-align: right; padding-right: 0; }
td.r + td:not(.r), th.r + th:not(.r), td.num + td, th.num + th { padding-left: 18px; }
tr.total td { border-top: 1px solid var(--ink); border-bottom: 0; font-weight: 600; padding-top: 14px; }
.status { font-size: 0.6875rem; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; white-space: nowrap; }
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
.check .rule-text { color: var(--ink-2); font-size: 0.8125rem; }
.check .detail { font-size: 0.8125rem; }
.check.fail .detail { color: var(--oxblood); }
.refusal { border: 1px solid var(--oxblood); background: #fbf3ef; box-shadow: 4px 4px 0 rgba(120,33,31,0.12); padding: 20px 22px; }
.refusal h2 { color: var(--oxblood); }
.code-chip { font-family: var(--mono); font-size: 0.75rem; border: 1px solid var(--oxblood); color: var(--oxblood); padding: 2px 8px; display: inline-block; }
.doc { border: 1px solid var(--rule); background: #fffdf7; padding: 20px 22px; font-family: var(--mono); font-size: 0.75rem; line-height: 1.9; white-space: pre-wrap; word-break: break-word; }
.doc mark { background: #f2d9d6; color: var(--oxblood); padding: 0 2px; }
.doc .hl { background: #e9dfc2; }
tr.diff td { background: #fbf3ef; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; font-size: 0.8125rem; }
.kv dt { color: var(--ink-3); }
.kv dd { margin: 0; text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.kv dd.em { font-weight: 600; }
button, .button { font-family: var(--sans); font-size: 0.8125rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; background: var(--ink); color: var(--paper); border: 1px solid var(--ink); padding: 11px 18px; cursor: pointer; box-shadow: 3px 3px 0 rgba(25,23,18,0.18); }
button:hover, .button:hover { background: #000; }
button:disabled { background: var(--paper-2); color: var(--ink-3); border-color: var(--rule); box-shadow: none; cursor: not-allowed; }
button.ghost { background: transparent; color: var(--ink); }
button.danger { background: var(--oxblood); border-color: var(--oxblood); }
:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.note { border-left: 2px solid var(--gold); padding: 2px 0 2px 14px; font-size: 0.8125rem; color: var(--ink-2); }
.override { border: 1px dashed var(--gold); background: #fbf6e8; padding: 12px 14px; font-size: 0.8125rem; }
footer { border-top: 1px solid var(--rule); margin-top: 64px; padding-top: 18px; font-size: 0.75rem; color: var(--ink-3); display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.empty { padding: 48px 0; color: var(--ink-3); font-family: var(--serif); font-size: 1.125rem; }
.role-strip { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 0.6875rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); border-bottom: 1px solid var(--rule); padding: 12px 0; margin-top: 24px; }
.role-strip a { border: 0; padding: 2px 8px; color: var(--ink-2); }
.role-strip a.on { background: var(--ink); color: var(--paper); }
@media (max-width: 640px) {
  .wrap { padding: 0 18px 64px; }
  .masthead .inner { padding: 16px 18px 14px; }
  h1 { font-size: 1.75rem; margin-top: 28px; }
  nav.top { gap: 14px; font-size: 0.6875rem; }
  th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
}
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
