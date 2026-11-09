import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT } from './config.ts';
import type { Cents } from './money.ts';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  countryCode?: string;
}

export interface EvidenceBundle {
  pod: {
    present: boolean;
    readable: boolean;
    carrier?: string;
    trackingNumber?: string;
    delivered?: boolean;
    deliveredOn?: string;
    consigneeName?: string;
    deliveryAddress?: Address;
    hasSignature?: boolean;
    hasPhoto?: boolean;
    poRef?: string;
    confidence?: Record<string, number>;
    sourceLines?: Record<string, string>;
  };
  invoice: {
    invoiceNumber: string;
    totalCents: Cents;
    issuedOn: string;
    dueOn: string;
    poRef?: string;
    lineItems: { description: string; cents: Cents }[];
  };
  debtor: {
    id: string;
    legalName: string;
    aliases?: string[];
    billingAddress: Address;
  };
  evidenceSha256: string;
  reusedEvidence: boolean;
  reusedTracker?: boolean;
  // Which invoice already carries this document, or this parcel. A refusal that names nothing is an
  // assertion; one that names the paper it collides with is something a seller can act on.
  reusedEvidenceOn?: string | null;
  reusedTrackerOn?: string | null;
  alreadyFinanced: boolean;
  protection: { status: string; trackerId?: string | null };
}

export interface CheckResult {
  checkId: string;
  title: string;
  rule: string;
  passed: boolean;
  detail: string;
  evidenceRegion: string | null;
  refusalCode: string | null;
  override: boolean;
}

export interface GateOutcome {
  verdict: 'VERIFIED' | 'REFUSED';
  checks: CheckResult[];
  refusals: { code: string; checkId: string; rule: string; region: string | null }[];
  overrides: { checkId: string; rawStatus: string; reason: string }[];
  /** Which profile decided this, so the page can say that the rules are data and name them. */
  jurisdiction?: { code: string; label: string };
  /**
   * False when the sale has no PayPal transaction behind it, so no rail fact corroborates it. That
   * is not the same as the rail answering "ineligible", which is an adverse fact and refuses. Absence
   * of corroboration is a priced condition: the desk continues, one band lower.
   */
  railCorroborated: boolean;
}

const RULES = YAML.parse(fs.readFileSync(path.join(ROOT, 'rules', 'checks.yaml'), 'utf8'));
const RULE_BY_ID = new Map<string, any>((RULES.checks as any[]).map((c) => [c.id, c]));

/**
 * What the seller can do about each refusal, written next to the check that raises it — rules as
 * data, the same as the checks themselves. A refusal that only says no is a dead end; this sentence
 * is what makes the refusal the product.
 */
const SELLER_ACTION_BY_CODE = new Map<string, string>();
for (const c of RULES.checks as any[]) {
  for (const key of ['refusal', 'refusalWhenUnreadable', 'refusalWhenLate']) {
    if (c[key] && c.seller_action && !SELLER_ACTION_BY_CODE.has(c[key])) {
      SELLER_ACTION_BY_CODE.set(c[key], String(c.seller_action).trim());
    }
  }
}

/** The check that raises a refusal code, as id and title, for pages that list refusals by reason. */
const CHECK_BY_CODE = new Map<string, { id: string; title: string }>();
for (const c of RULES.checks as any[]) {
  for (const key of ['refusal', 'refusalWhenUnreadable', 'refusalWhenLate']) {
    if (c[key] && !CHECK_BY_CODE.has(c[key])) CHECK_BY_CODE.set(c[key], { id: String(c.id), title: String(c.title).trim() });
  }
}

export function checkForCode(code: string | null | undefined): { id: string; title: string } | null {
  return code ? CHECK_BY_CODE.get(code) ?? null : null;
}

export function sellerActionFor(code: string | null | undefined): string | null {
  return SELLER_ACTION_BY_CODE.get(String(code ?? '')) ?? null;
}

/**
 * The jurisdiction is part of the rules, not of the code: which carriers this desk will believe,
 * what a postal code looks like, how stale a delivery may be, how long a tenor may run, and what
 * PayPal calls the protection behind the sale. Everything else — the eleven checks, the price, the
 * ledger — is the same in every profile.
 */
export interface Jurisdiction {
  label: string;
  countryCode: string;
  protectionProgram: string;
  deliveryWindowDays: number;
  maximumTenorDays: number;
  /** How many days past the due date the desk waits before it calls the paper overdue. */
  graceDays: number;
  minimumConfidence: number;
  postalCode: { pattern: string; normalise: string; significant: number };
  carriers: { name: string; match: string; pattern: string }[];
}

const JURISDICTIONS = YAML.parse(fs.readFileSync(path.join(ROOT, 'rules', 'jurisdictions.yaml'), 'utf8'));
const PROFILES: Record<string, Jurisdiction> = JURISDICTIONS.profiles ?? {};
export const DEFAULT_JURISDICTION: Jurisdiction = PROFILES[JURISDICTIONS.default] ?? PROFILES.US;
export const JURISDICTION_CODES: string[] = Object.keys(PROFILES);

export function jurisdictionFor(code: string | null | undefined): Jurisdiction {
  return PROFILES[String(code ?? '').toUpperCase()] ?? DEFAULT_JURISDICTION;
}

/**
 * Every carrier this desk can validate, in every profile, compiled once. The deterministic parser
 * reads from here rather than keeping its own list, so a new carrier row in jurisdictions.yaml makes
 * the parser recognise the name and the gate believe the number — one edit, not two.
 */
export const ALL_CARRIERS: { name: string; match: RegExp }[] = (() => {
  const seen = new Map<string, RegExp>();
  for (const code of JURISDICTION_CODES) {
    for (const c of PROFILES[code].carriers ?? []) {
      if (!seen.has(c.name)) seen.set(c.name, new RegExp(c.match, 'i'));
    }
  }
  return [...seen].map(([name, match]) => ({ name, match }));
})();

/** Rule sentences in checks.yaml carry {placeholders} so one file reads correctly in every profile. */
function ruleText(id: string, j: Jurisdiction): string {
  return String(RULE_BY_ID.get(id)?.rule ?? '').replace(/\{(\w+)\}/g, (_m, key) => String((j as any)[key] ?? `{${key}}`));
}

/** For check rows written before the rule text was stored, the page re-renders it from the rule set. */
export function ruleTextFor(id: string, j: Jurisdiction): string {
  return ruleText(id, j);
}

const LEGAL_SUFFIXES = /\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|ltd|limited|company|holdings|group|usa|us)\b/g;
const STREET_WORDS: Record<string, string> = {
  street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr', lane: 'ln',
  court: 'ct', place: 'pl', parkway: 'pkwy', suite: 'ste', north: 'n', south: 's',
  east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw'
};

export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeStreet(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

// One delivery, one receivable. A tracking number written as `1z 9400 / 1111` and as
// `1Z94001111` is the same parcel, so E06 compares the digits and letters and nothing else.
export function normaliseTracker(input: string | undefined | null): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 6 ? s : null;
}

export function namesMatch(consignee: string | undefined, legalName: string, aliases: string[] = []): boolean {
  if (!consignee) return false;
  const a = normalizeName(consignee);
  if (!a) return false;
  const candidates = [normalizeName(legalName), ...aliases.map(normalizeName)].filter(Boolean);
  if (candidates.includes(a)) return true;
  const aTokens = new Set(a.split(' ').filter((t) => t.length > 1));
  for (const c of candidates) {
    const cTokens = c.split(' ').filter((t) => t.length > 1);
    // A single-token candidate is what a legal suffix leaves behind ("Halcyon Group" -> "halcyon").
    // It matches on equality only, never as a subset, or every consignee beginning with the first
    // word would pass.
    if (cTokens.length < 2) continue;
    if (cTokens.every((t) => aTokens.has(t))) return true;
  }
  return false;
}

export function addressesMatch(delivered: Address | undefined, billing: Address, j: Jurisdiction = DEFAULT_JURISDICTION): boolean {
  if (!delivered) return false;
  const streetOk = normalizeStreet(delivered.line1) === normalizeStreet(billing.line1);
  const cityOk = (delivered.city || '').trim().toLowerCase() === billing.city.trim().toLowerCase();
  const code = (s?: string) => {
    const raw = String(s ?? '');
    const kept = j.postalCode.normalise === 'digits' ? raw.replace(/\D/g, '') : raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return j.postalCode.significant > 0 ? kept.slice(0, j.postalCode.significant) : kept;
  };
  // A code that is not a code at all cannot corroborate an address, in either direction.
  const shaped = new RegExp(j.postalCode.pattern, 'i');
  return streetOk && cityOk && !!delivered.postalCode
    && shaped.test(String(delivered.postalCode).replace(/\s+/g, ''))
    && code(delivered.postalCode) === code(billing.postalCode) && code(delivered.postalCode).length > 0;
}

const patternsCache = new WeakMap<Jurisdiction, { carrier: string; re: RegExp }[]>();

function trackingPatterns(j: Jurisdiction): { carrier: string; re: RegExp }[] {
  let cached = patternsCache.get(j);
  if (!cached) {
    cached = (j.carriers ?? []).map((c) => ({ carrier: c.name, re: new RegExp(c.pattern, 'i') }));
    patternsCache.set(j, cached);
  }
  return cached;
}

export function canonicalCarrier(carrier: string | undefined, j: Jurisdiction = DEFAULT_JURISDICTION): string | null {
  if (!carrier) return null;
  for (const c of j.carriers ?? []) {
    if (new RegExp(c.match, 'i').test(carrier)) return c.name;
  }
  return null;
}

export function trackingIsValid(carrier: string | undefined, tracking: string | undefined, j: Jurisdiction = DEFAULT_JURISDICTION): { ok: boolean; reason: string } {
  if (!tracking) return { ok: false, reason: 'no tracking number on the document' };
  // Paper writes the same parcel several ways: `1Z999AA10123456784`, `1z 999 aa1 0123 4567 84`,
  // `1Z-999-AA1-…`. Anything that is not a letter or a digit is typography, so it comes off before
  // the pattern is tested — and the number is then compared the same way everywhere else in the gate.
  const value = tracking.toUpperCase().replace(/[^A-Z0-9]/g, '') || tracking.toUpperCase();
  if (!carrier) return { ok: false, reason: `tracking ${value} has no carrier named` };
  // Documents name carriers loosely ("FEDEX FREIGHT", "Fed Ex", "United Parcel Service"). Map the
  // name onto the services this profile can validate; an unknown carrier is a refusal.
  const canonical = canonicalCarrier(carrier, j);
  if (!canonical) return { ok: false, reason: `carrier ${carrier} is not one the ${j.label} desk can verify` };
  const pattern = trackingPatterns(j).find((p) => p.carrier === canonical)!;
  if (!pattern.re.test(value)) return { ok: false, reason: `${value} is not a well-formed ${pattern.carrier} tracking number` };
  return { ok: true, reason: `${pattern.carrier} ${value}` };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function lowConfidence(bundle: EvidenceBundle, field: string, j: Jurisdiction): boolean {
  const c = bundle.pod.confidence?.[field];
  return c !== undefined && c < j.minimumConfidence;
}

/**
 * Whether the check is standing on the value a field holds rather than on its absence. A below-the-floor
 * absence is not what a pass rests on — E10 may pass on a delivery photograph while the parser's 60%
 * "no signature line found" is a weak reading of nothing at all.
 */
function standsOn(bundle: EvidenceBundle, field: string): boolean {
  const v = (bundle.pod as Record<string, unknown>)[field];
  return v !== undefined && v !== null && v !== false && v !== '';
}

/**
 * Which document fields a check's verdict rests on. The confidence floor in the jurisdiction profile
 * is applied through this map in the one place every check reports, so a below-the-floor reading can
 * lose a check but can never win one — see record(). E06 is absent on purpose: its claim is about the
 * hash of the file, which is a fact about the upload and not a reading of the paper.
 */
const FIELDS_BEHIND_CHECK: Record<string, string[]> = {
  E02: ['trackingNumber'],
  E03: ['delivered', 'deliveredOn'],
  E04: ['consigneeName'],
  E05: ['deliveryAddress'],
  E10: ['hasSignature']
};

export interface GateOptions {
  sandbox: boolean;
  allowProtectionOverride: boolean;
  now?: Date;
}

export function runGate(bundle: EvidenceBundle, options: GateOptions): GateOutcome {
  const checks: CheckResult[] = [];
  const overrides: GateOutcome['overrides'] = [];
  const j = jurisdictionFor(bundle.debtor.billingAddress?.countryCode);

  const podUsable = bundle.pod.present && bundle.pod.readable
    && !lowConfidence(bundle, 'trackingNumber', j) && !lowConfidence(bundle, 'consigneeName', j);
  const POD_DEPENDENT = new Set(['E02', 'E03', 'E04', 'E05', 'E10']);

  const record = (id: string, passed: boolean, detail: string, region: string | null, refusalCode: string | null, override = false): void => {
    const def = RULE_BY_ID.get(id);
    if (!podUsable && POD_DEPENDENT.has(id)) {
      checks.push({
        checkId: id,
        title: def?.title ?? id,
        rule: ruleText(id, j),
        passed: false,
        detail: 'Not evaluated: there is no readable proof of delivery for this check to read.',
        evidenceRegion: 'document',
        refusalCode: null,
        override: false
      });
      return;
    }
    // A check may fail on a field the desk read badly — the ordinary failure says which — but it may
    // not pass on one. The floor used to cover only the two identity fields, which left the odd result
    // of a clean tick next to a value the desk had itself written down as unreliable. A low-confidence
    // absence is not converted: "no signature line found" is a missing piece of evidence, and
    // relabelling it unreadable would hide which piece is missing.
    const shakyField = passed ? (FIELDS_BEHIND_CHECK[id] ?? []).find((f) => standsOn(bundle, f) && lowConfidence(bundle, f, j)) : undefined;
    if (shakyField !== undefined) {
      checks.push({
        checkId: id,
        title: def?.title ?? id,
        rule: ruleText(id, j),
        passed: false,
        detail: `${shakyField} was read at ${Math.round(Number(bundle.pod.confidence?.[shakyField]) * 100)}%, below the ${Math.round(j.minimumConfidence * 100)}% floor the ${j.label} profile sets, so this check will not pass on it.`,
        evidenceRegion: region,
        refusalCode: 'POD_UNREADABLE',
        override: false
      });
      return;
    }
    checks.push({
      checkId: id,
      title: def?.title ?? id,
      rule: ruleText(id, j),
      passed,
      detail,
      evidenceRegion: region,
      refusalCode: passed ? null : refusalCode,
      override
    });
  };

  // E00 — PayPal's own protection. A receivable PayPal will not stand behind is not financeable.
  // Three answers, not two: the rail says yes, the rail says no, or there is no rail transaction to
  // ask about. The last is not a pass — it is a sale the desk can only price on its paperwork.
  let railCorroborated = true;
  {
    const status = (bundle.protection.status || 'UNKNOWN').toUpperCase();
    const region = 'protection';
    if (status === 'ELIGIBLE') {
      const tracker = bundle.protection.trackerId ? ` Tracked as ${bundle.protection.trackerId}.` : '';
      record('E00', true, `PayPal returns ${j.protectionProgram} ELIGIBLE for this account.${tracker}`, region, null);
    } else if (status === 'NOT_ON_RAIL') {
      railCorroborated = false;
      record('E00', true, 'No PayPal transaction underlies this sale, so there is nothing on the rail to corroborate it. Recorded as uncorroborated: the gate runs on the documents and the debtor history alone, and the price is set one band lower for the loss of the rail signal.', region, null);
    } else if (options.sandbox && options.allowProtectionOverride) {
      const reason = `Sandbox override: PayPal returned ${status} for the sandbox account in use. The check is recorded as overridden, not passed.`;
      record('E00', true, reason, region, null, true);
      overrides.push({ checkId: 'E00', rawStatus: status, reason });
    } else {
      record('E00', false, `PayPal returns ${status}: this sale is not protected, so it cannot be financed.`, region, RULE_BY_ID.get('E00')?.refusal ?? 'PROTECTION_INELIGIBLE');
    }
  }

  // E01 — a present, readable proof of delivery.
  {
    if (!bundle.pod.present) {
      record('E01', false, 'No proof of delivery is attached to this invoice.', 'document', 'POD_MISSING');
    } else if (!bundle.pod.readable) {
      record('E01', false, 'The proof of delivery could not be read: no usable fields were extracted.', 'document', 'POD_UNREADABLE');
    } else if (!podUsable) {
      record('E01', false, 'A required field was extracted below the confidence floor, so it is treated as unreadable rather than guessed.', 'document', 'POD_UNREADABLE');
    } else {
      record('E01', true, 'Proof of delivery is present and readable.', 'document', null);
    }
  }

  // E02 — carrier and tracking.
  {
    const t = trackingIsValid(bundle.pod.carrier, bundle.pod.trackingNumber, j);
    record('E02', t.ok, t.ok ? `Tracking number is well-formed: ${t.reason}. The carrier itself is not queried.` : t.reason, 'pod.trackingNumber', 'TRACKING_INVALID');
  }

  // E03 — delivered, and inside the window.
  {
    const deliveredOn = isoDate(bundle.pod.deliveredOn);
    const issuedOn = isoDate(bundle.invoice.issuedOn);
    if (bundle.pod.delivered !== true) {
      record('E03', false, 'The document does not state that the parcel was delivered.', 'pod.status', 'NOT_DELIVERED');
    } else if (!deliveredOn) {
      record('E03', false, 'The delivery date is missing or not a real date.', 'pod.deliveredOn', 'NOT_DELIVERED');
    } else if (!issuedOn) {
      record('E03', false, 'The invoice date is missing or not a real date.', 'invoice.issuedOn', 'TERMS_INVALID');
    } else {
      const gap = daysBetween(deliveredOn, issuedOn);
      if (gap < 0) {
        record('E03', false, `Delivery ${deliveredOn} is after the invoice date ${issuedOn}.`, 'pod.deliveredOn', 'DELIVERY_DATE_OUT_OF_WINDOW');
      } else if (gap > j.deliveryWindowDays) {
        record('E03', false, `Delivered ${gap} days before the invoice; the ${j.label} limit is ${j.deliveryWindowDays}.`, 'pod.deliveredOn', 'DELIVERY_DATE_OUT_OF_WINDOW');
      } else {
        record('E03', true, `Delivered ${deliveredOn}, ${gap} day(s) before the invoice date.`, 'pod.deliveredOn', null);
      }
    }
  }

  // E04 — consignee is the debtor.
  {
    const ok = namesMatch(bundle.pod.consigneeName, bundle.debtor.legalName, bundle.debtor.aliases);
    record(
      'E04',
      ok,
      ok
        ? `Consignee "${bundle.pod.consigneeName}" matches the debtor "${bundle.debtor.legalName}".`
        : `Consignee "${bundle.pod.consigneeName ?? 'missing'}" does not match the debtor "${bundle.debtor.legalName}".`,
      'pod.consigneeName',
      'CONSIGNEE_MISMATCH'
    );
  }

  // E05 — the delivery address is the billing address.
  {
    const ok = addressesMatch(bundle.pod.deliveryAddress, bundle.debtor.billingAddress, j);
    const d = bundle.pod.deliveryAddress;
    record(
      'E05',
      ok,
      ok
        ? `Delivered to ${d?.line1}, ${d?.city} ${d?.postalCode}, the debtor's billing address under the ${j.label} postal-code rule.`
        : `Delivered to ${d?.line1 ?? 'missing'}, ${d?.city ?? ''} ${d?.postalCode ?? ''}, which is not the billing address on file.`,
      'pod.deliveryAddress',
      'ADDRESS_MISMATCH'
    );
  }

  // E06 — this delivery has not been financed before, by the file or by the parcel.
  {
    const tracker = normaliseTracker(bundle.pod.trackingNumber);
    if (bundle.reusedEvidence) {
      record('E06', false,
        `This document hash ${bundle.evidenceSha256.slice(0, 16)}… is already filed against invoice ${bundle.reusedEvidenceOn ?? 'another'}.`,
        'evidence.sha256', 'EVIDENCE_REUSED');
    } else if (bundle.reusedTracker && tracker) {
      record('E06', false,
        `Tracking number ${bundle.pod.trackingNumber} already appears on invoice ${bundle.reusedTrackerOn ?? 'another'}'s delivery document. The file is new; the parcel is not, and one delivery cannot finance two receivables.`,
        'pod.trackingNumber', 'TRACKER_REUSED');
    } else {
      // E06's own claim is about the file, so a shaky tracking number does not fail it — but it is not
      // quoted as unique either. A parcel number read below the floor is evidence of nothing.
      const trackerTrusted = tracker !== null && !lowConfidence(bundle, 'trackingNumber', j);
      record('E06', true,
        trackerTrusted
          ? `Document hash ${bundle.evidenceSha256.slice(0, 16)}… and tracking number ${bundle.pod.trackingNumber} are both unique to this invoice.`
          : `Document hash ${bundle.evidenceSha256.slice(0, 16)}… is unique to this invoice; ${tracker ? 'the tracking number was read below the floor, so the parcel was not compared' : 'no readable tracking number to compare'}.`,
        'evidence.sha256', null);
    }
  }

  // E07 — this invoice has not been financed.
  {
    record(
      'E07',
      !bundle.alreadyFinanced,
      bundle.alreadyFinanced
        ? `Invoice ${bundle.invoice.invoiceNumber} is already attached to a listed or funded invoice for this debtor.`
        : `Invoice ${bundle.invoice.invoiceNumber} has not been financed for this debtor.`,
      'invoice.invoiceNumber',
      'INVOICE_ALREADY_FINANCED'
    );
  }

  // E08 — arithmetic and the purchase order.
  {
    const sum = bundle.invoice.lineItems.reduce((acc, li) => acc + li.cents, 0);
    if (sum !== bundle.invoice.totalCents) {
      record('E08', false, `Line items sum to ${sum} cents but the invoice states ${bundle.invoice.totalCents} cents.`, 'invoice.totalCents', 'AMOUNT_MISMATCH');
    } else if (bundle.invoice.poRef && bundle.pod.poRef && bundle.invoice.poRef.trim() !== bundle.pod.poRef.trim()) {
      record('E08', false, `The invoice cites PO ${bundle.invoice.poRef} but the delivery document cites ${bundle.pod.poRef}.`, 'invoice.poRef', 'AMOUNT_MISMATCH');
    } else {
      record('E08', true, `${bundle.invoice.lineItems.length} line items reconcile to the stated total.`, 'invoice.totalCents', null);
    }
  }

  // E09 — terms.
  {
    const issued = isoDate(bundle.invoice.issuedOn);
    const due = isoDate(bundle.invoice.dueOn);
    if (!issued || !due) {
      record('E09', false, 'The issue or due date is missing or not a real date.', 'invoice.dueOn', 'TERMS_INVALID');
    } else {
      const tenor = daysBetween(issued, due);
      if (tenor < 0) record('E09', false, `The due date ${due} precedes the issue date ${issued}.`, 'invoice.dueOn', 'TERMS_INVALID');
      else if (tenor > j.maximumTenorDays) record('E09', false, `Tenor is ${tenor} days; the ${j.label} limit is ${j.maximumTenorDays}.`, 'invoice.dueOn', 'TERMS_INVALID');
      else record('E09', true, `${tenor}-day tenor from ${issued} to ${due}.`, 'invoice.dueOn', null);
    }
  }

  // E10 — someone took receipt.
  {
    const ok = bundle.pod.hasSignature === true || bundle.pod.hasPhoto === true;
    record(
      'E10',
      ok,
      ok
        ? `Receipt is evidenced by ${bundle.pod.hasSignature ? 'a signature' : 'a delivery photograph'}.`
        : 'Neither a signature nor a delivery photograph appears on the document.',
      bundle.pod.hasSignature ? 'pod.signature' : 'pod.photo',
      'NO_SIGNATURE_EVIDENCE'
    );
  }

  const refusals = checks
    .filter((c) => !c.passed && c.refusalCode !== null)
    .map((c) => ({
      code: c.refusalCode as string,
      checkId: c.checkId,
      rule: c.rule,
      region: c.evidenceRegion,
      sellerAction: sellerActionFor(c.refusalCode)
    }));

  return {
    verdict: refusals.length === 0 ? 'VERIFIED' : 'REFUSED',
    checks,
    refusals,
    overrides,
    jurisdiction: { code: j.countryCode, label: j.label },
    railCorroborated
  };
}
