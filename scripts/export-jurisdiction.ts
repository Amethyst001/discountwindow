import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { runGate, jurisdictionFor, type EvidenceBundle } from '../src/gate.ts';
import { ROOT } from '../src/config.ts';

/**
 * Write the portability artefact: the Royal Mail receipt that the seeded book verifies under the GB
 * profile, decided again with the US profile's tables. Regenerate with
 * `node scripts/export-jurisdiction.ts`; the document text is the one stored with invoice MT-2207, so
 * the evidence hash in this file is the one the deal room prints.
 */
const db = openDb();
const row = db.prepare("SELECT id FROM invoices WHERE invoice_number = 'MT-2207'").get() as any;
if (!row) throw new Error('MT-2207 is not on this book; run npm run seed');
const inv = db.prepare(`
  SELECT i.*, d.legal_name AS debtor_name, d.billing_address_json, e.sha256, e.mime, e.bytes, x.fields_json
    FROM invoices i
    JOIN debtors d ON d.id = i.debtor_id
    JOIN evidence_files e ON e.invoice_id = i.id
    JOIN extractions x ON x.evidence_id = e.id
   WHERE i.id = ?`).get(row.id) as any;

const fields = JSON.parse(inv.fields_json);
const bundle: EvidenceBundle = {
  pod: fields.pod,
  invoice: { ...fields.invoice, invoiceNumber: inv.invoice_number, totalCents: Number(inv.face_cents), issuedOn: inv.issued_on, dueOn: inv.due_on },
  debtor: { id: inv.debtor_id, legalName: inv.debtor_name, aliases: ['Meridian Trading'], billingAddress: JSON.parse(inv.billing_address_json) },
  evidenceSha256: inv.sha256,
  reusedEvidence: false,
  alreadyFinanced: false,
  protection: { status: 'UNKNOWN', trackerId: fields.pod.trackingNumber }
};

const opts = { sandbox: true, allowProtectionOverride: true };
const decided = runGate(bundle, opts);
// The same bundle, read with the other country's tables: only the debtor's billing country moves.
const asUS: EvidenceBundle = {
  ...bundle,
  debtor: { ...bundle.debtor, billingAddress: { ...bundle.debtor.billingAddress, countryCode: 'US' } }
};
const foreign = runGate(asUS, opts);

// The seeded invoice runs a 60-day tenor, which sits inside both caps, so it cannot show the cap
// moving. One variant, with the same document and the same dates until maturity, is pushed to 120
// days: still inside the United Kingdom cap, outside the United States one. Nothing else changes.
const longTenor: EvidenceBundle = {
  ...bundle,
  invoice: { ...bundle.invoice, dueOn: '2027-02-12' }
};
const longGB = runGate(longTenor, opts);
const longUS = runGate({ ...longTenor, debtor: { ...longTenor.debtor, billingAddress: { ...longTenor.debtor.billingAddress, countryCode: 'US' } } }, opts);

const outcome = (g: ReturnType<typeof runGate>) => ({
  jurisdiction: g.jurisdiction,
  verdict: g.verdict,
  checks: g.checks.map((c) => ({ id: c.checkId, passed: c.passed, rule: c.rule, detail: c.detail })),
  refusals: g.refusals.map((r) => r.code)
});

const doc = {
  generated_at: new Date().toISOString().slice(0, 10),
  claim: 'The eleven checks are the same in every country; only rules/jurisdictions.yaml changes. This is one document decided under both shipped profiles.',
  invoice: { number: inv.invoice_number, face_cents: Number(inv.face_cents), issued_on: inv.issued_on, due_on: inv.due_on, debtor: inv.debtor_name },
  evidence: { sha256: inv.sha256, mime: inv.mime, bytes: Number(inv.bytes) },
  profiles: {
    gb: { ...outcome(decided), note: 'what the seeded book holds; MT-2207 verifies and prices under this profile' },
    us: { ...outcome(foreign), note: 'the identical bundle, the identical document, decided with the United States tables' }
  },
  tenor_variant: {
    change: 'the same document and the same issue date, matured on 2027-02-12 instead: a 120-day tenor',
    gb: { verdict: longGB.verdict, refusals: longGB.refusals.map((r) => r.code), e09: longGB.checks.find((c) => c.checkId === 'E09')?.detail },
    us: { verdict: longUS.verdict, refusals: longUS.refusals.map((r) => r.code), e09: longUS.checks.find((c) => c.checkId === 'E09')?.detail }
  },
  what_moved: foreign.refusals.map((r) => ({ check: r.checkId, code: r.code, because: 'the United States profile does not carry this carrier or this postcode shape' })),
  what_did_not_move: decided.checks
    .filter((c) => c.passed && foreign.checks.find((f) => f.checkId === c.checkId)?.passed)
    .map((c) => c.checkId),
  currency_note: 'Both profiles settle in US dollars in this build; the profile governs the evidence rules, not the settlement currency.'
};

const out = path.join(ROOT, 'evidence', 'published', 'x7-jurisdiction-profiles.json');
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(out);
console.log('GB', doc.profiles.gb.verdict, '/ US', doc.profiles.us.verdict, doc.profiles.us.refusals.join(','));
console.log('120-day tenor: GB', doc.tenor_variant.gb.verdict, '/ US', doc.tenor_variant.us.verdict, doc.tenor_variant.us.refusals.join(','));
