import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, i).trim()] = v;
  }
  return env;
}

const fileEnv = loadEnvFile(path.join(ROOT, '.env'));
const read = (k: string, fallback = ''): string => process.env[k] ?? fileEnv[k] ?? fallback;

export const config = {
  paypalBase: read('PAYPAL_BASE', 'https://api-m.sandbox.paypal.com'),
  clientId: read('PAYPAL_CLIENT_ID'),
  clientSecret: read('PAYPAL_CLIENT_SECRET'),
  webhookId: read('PAYPAL_WEBHOOK_ID'),
  platformMerchantId: read('PAYPAL_PLATFORM_MERCHANT_ID'),
  platformEmail: read('PAYPAL_PLATFORM_EMAIL'),
  sellerEmail: read('PAYPAL_SELLER_EMAIL'),
  funderEmail: read('PAYPAL_FUNDER_EMAIL'),
  debtorEmail: read('PAYPAL_DEBTOR_EMAIL'),
  port: Number(read('PORT', '3000')),
  // One shared password in front of a public demo URL. Empty means open, which is for localhost.
  demoPassword: read('DEMO_PASSWORD'),
  // The shared password admits anyone to the demo, and the username then picks the role — which means
  // the holder of that one password can also type `desk` and hold every button. Where a per-side
  // secret is set, it replaces the shared one for that side, and the role stops being self-declared.
  demoPasswordsByRole: {
    desk: read('DEMO_PASSWORD_DESK'),
    seller: read('DEMO_PASSWORD_SELLER'),
    funder: read('DEMO_PASSWORD_FUNDER'),
    debtor: read('DEMO_PASSWORD_DEBTOR')
  } as Record<string, string>,
  dbPath: read('DB_PATH', path.join(ROOT, 'data', 'discountwindow.sqlite')),
  evidenceDir: read('EVIDENCE_DIR', path.join(ROOT, 'data', 'evidence')),
  // Optional second-pass reader for documents the deterministic parser cannot line up. Any
  // OpenAI-compatible chat endpoint works; with no key the app never leaves the deterministic path.
  geminiKey: read('EXTRACT_API_KEY'),
  geminiBase: read('EXTRACT_BASE_URL'),
  geminiModel: read('EXTRACT_MODEL'),
  // A second, independent reader of the same photograph, in a different weight family. Without it a
  // scanned document still gets two readers, but only one of them sees pixels; with it, neither field
  // answer stands on a single model's word.
  extractBKey: read('EXTRACT_B_API_KEY'),
  extractBBase: read('EXTRACT_B_BASE_URL'),
  extractBModel: read('EXTRACT_B_MODEL')
};

// The client refuses to start on any non-sandbox host. This is a literal check, not a pattern
// match, so a typo in an env file cannot point the app at production. Cleartext is refused for the
// same reason: the basic-auth header would carry the client secret over an unencrypted link.
const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
const SANDBOX_SVC_HOST = 'svcs.sandbox.paypal.com';

export function assertSandbox(base = config.paypalBase): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`refusing to start: PayPal base must be ${SANDBOX_HOST}, got an unparseable value`);
  }
  if (url.hostname !== SANDBOX_HOST) {
    throw new Error(`refusing to start: PayPal base must be ${SANDBOX_HOST}, got ${url.hostname}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`refusing to start: PayPal base must use https, got ${url.protocol}//${url.hostname}`);
  }
  return url;
}

export function isSandbox(): boolean {
  try {
    assertSandbox();
    return true;
  } catch {
    return false;
  }
}

export const hosts = { SANDBOX_HOST, SANDBOX_SVC_HOST };
