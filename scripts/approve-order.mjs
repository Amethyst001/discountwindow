// Approves a sandbox checkout in a real browser. PayPal's final pay button ignores synthetic DOM
// clicks, so this drives Edge over CDP and clicks with trusted input events.
//
// Usage: node scripts/approve-order.mjs <checkout-url> [account]
//   account: funder (default) | business
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[t.slice(0, i).trim()] = v;
    }
  }
  return env;
}
const env = loadEnv(path.join(ROOT, '.env'));
const url = process.argv[2];
const account = process.argv[3] ?? 'funder';
if (!url?.startsWith('https://www.sandbox.paypal.com/')) throw new Error('pass the sandbox checkout URL');
const email = account === 'business' ? env.PAYPAL_BUSINESS_EMAIL : env.PAYPAL_FUNDER_EMAIL;
const password = account === 'business' ? env.PAYPAL_BUSINESS_PASSWORD : env.PAYPAL_FUNDER_PASSWORD;
if (!email || !password) throw new Error(`no credentials for ${account}`);

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.join(ROOT, 'temp', 'edge-profile');
fs.mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: edge,
  headless: true,
  userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900']
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
page.on('requestfailed', (r) => console.log('requestfailed:', r.url().slice(0, 120), r.failure()?.errorText));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

async function visibleText() {
  return page.evaluate(() => document.body?.innerText ?? '');
}
async function clickText(re) {
  const handle = await page.evaluateHandle((source) => {
    const rx = new RegExp(source, 'i');
    const nodes = [...document.querySelectorAll('button, input[type=submit], a, div[role=button]')];
    return nodes.find((n) => rx.test((n.textContent || n.value || '').trim())) ?? null;
  }, re.source);
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoView();
  const box = await element.boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 150));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  return true;
}
async function loginIfAsked() {
  const hasPassword = await page.$('input[type=password]');
  if (!hasPassword) return false;
  const emailValue = await page.evaluate(() => document.querySelector('input[name=login_email], input[type=email], #email')?.value ?? '');
  if (emailValue !== email) {
    await page.evaluate((value) => {
      const field = document.querySelector('input[name=login_email], input[type=email], #email');
      if (field) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, email);
  }
  await page.evaluate((value) => {
    const field = document.querySelector('input[type=password]');
    if (field) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, password);
  if (!(await clickText(/^log in$/))) throw new Error('no login button');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

const log = [];
await loginIfAsked();
log.push(`after login: ${page.url()}`);

// Wait for the review page, click once, then let the flow finish. Re-clicking restarts the
// wallet load and the payment never lands.
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const text = await visibleText();
  if (/complete purchase|pay now/i.test(text)) break;
  if (attempt % 5 === 0) log.push(`waiting: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
}
const clicked = await clickText(/^(complete purchase|pay now)$/);
log.push(`clicked=${clicked} url=${page.url()}`);
let paid = false;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const text = await visibleText();
  if (attempt % 3 === 0) log.push(`poll ${attempt + 1}: ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
  if (/payment complete|you paid|thank you|receipt|return to|continue to/i.test(text) && !/getting your wallet/i.test(text)) {
    paid = true;
    break;
  }
  if (!/(getting your wallet|complete purchase|pay now)/i.test(text) && text.trim().length > 0 && attempt > 2) {
    paid = true;
    break;
  }
}
await new Promise((r) => setTimeout(r, 2000));
const finalText = (await visibleText()).slice(0, 400);
console.log(JSON.stringify({ finalUrl: page.url(), finalText, log }, null, 2));
await page.screenshot({ path: path.join(ROOT, 'temp', `approve-${Date.now()}.png`), fullPage: false }).catch(() => null);
await browser.close();
