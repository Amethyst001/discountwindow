// Provision sandbox accounts through Adaptive Accounts (sandbox only).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) { let v = t.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[t.slice(0, i).trim()] = v; }
  }
  return env;
}
const env = loadEnv(path.join(ROOT, '.env'));

const ACCOUNTS = JSON.parse(process.argv[2] || '[]');

async function create(acc) {
  const body = {
    accountType: acc.type,
    registrationType: 'Web',
    citizenshipCountryCode: 'US',
    contactPhoneNumber: '4155551234',
    currencyCode: 'USD',
    dateOfBirth: '1985-03-04Z',
    emailAddress: acc.email,
    name: { firstName: acc.first, lastName: acc.last },
    address: { line1: '1 Market St', city: 'San Jose', state: 'CA', postalCode: '95131', countryCode: 'US' },
    preferredLanguageCode: 'en_US',
    createAccountWebOptions: { returnUrl: 'https://example.com/return', showAddCreditCard: 'false' },
    ...(acc.type === 'BUSINESS' ? {
      businessInfo: {
        businessName: acc.businessName || 'Discount Window LLC',
        businessAddress: { line1: '1 Market St', city: 'San Jose', state: 'CA', postalCode: '95131', countryCode: 'US' },
        workPhone: '4155551234',
        businessType: 'LLC',
        category: 1004,
        averagePrice: 250,
        averageMonthlyVolume: 20000,
        percentageRevenueFromOnline: 100,
        salesVenue: 'WEB',
        ...(acc.subCategory ? { subCategory: acc.subCategory } : {}),
        dateOfEstablishment: '2019-01-15Z',
        customerServicePhone: '4155551234',
        customerServiceEmail: acc.email,
        website: 'https://example.com'
      }
    } : {}),
    requestEnvelope: { errorLanguage: 'en_US', detailLevel: 'ReturnAll' }
  };
  const r = await fetch('https://svcs.sandbox.paypal.com/AdaptiveAccounts/CreateAccount', {
    method: 'POST',
    headers: {
      'X-PAYPAL-SECURITY-USERID': env.PAYPAL_NVP_USERNAME,
      'X-PAYPAL-SECURITY-PASSWORD': env.PAYPAL_NVP_PASSWORD,
      'X-PAYPAL-SECURITY-SIGNATURE': env.PAYPAL_NVP_SIGNATURE,
      'X-PAYPAL-REQUEST-DATA-FORMAT': 'JSON',
      'X-PAYPAL-RESPONSE-DATA-FORMAT': 'JSON',
      'X-PAYPAL-APPLICATION-ID': 'APP-80W284485P519543T',
      'X-PAYPAL-DEVICE-IPADDRESS': '203.0.113.10',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* raw */ }
  return {
    email: acc.email,
    ack: j?.responseEnvelope?.ack || String(r.status),
    accountId: j?.accountId || null,
    redirectURL: j?.redirectURL || null,
    raw: text.slice(0, 900),
    errors: j?.error || (j ? null : text.slice(0, 400))
  };
}

const out = [];
for (const a of ACCOUNTS) out.push(await create(a));
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(ROOT, 'evidence', 'd0', 'accounts-' + Date.now() + '.json'), JSON.stringify(out, null, 2));
