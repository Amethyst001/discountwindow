import { config } from './config.ts';
import { ALL_CARRIERS, canonicalCarrier, jurisdictionFor, type Address, type EvidenceBundle } from './gate.ts';

/**
 * Evidence extraction.
 *
 * The document supplies fields and a confidence per field. It never decides: the gate reads these
 * fields and applies the rules in rules/checks.yaml. Two extractors run on every document — a model
 * and a deterministic label parser — and their answers are compared. Disagreement halves the
 * confidence, which is often enough to cross the threshold and refuse as POD_UNREADABLE.
 */

export interface Extraction {
  model: string;
  modelVersion: string;
  text: string;
  pod: EvidenceBundle['pod'];
  invoiceHints: { invoiceNumber?: string; poRef?: string };
  confidence: Record<string, number>;
  /**
   * What each comparison decided, field by field. When a document is photographed the same field is
   * compared twice — between the two readers of the pixels, and then against the label parser — and a
   * disagreement the first comparison found cannot be healed by the second one agreeing. So the verdict
   * travels with the reading and the final confidence is the worse of them.
   */
  verdicts?: Record<string, number>;
  notes: string[];
  raw: unknown;
}

const FIELDS = ['trackingNumber', 'consigneeName', 'deliveredOn', 'deliveryAddress', 'hasSignature', 'delivered'] as const;

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const named = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (named && MONTHS[named[1].toLowerCase()]) {
    return `${named[3]}-${MONTHS[named[1].toLowerCase()]}-${named[2].padStart(2, '0')}`;
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (dayFirst && MONTHS[dayFirst[2].toLowerCase()]) {
    return `${dayFirst[3]}-${MONTHS[dayFirst[2].toLowerCase()]}-${dayFirst[1].padStart(2, '0')}`;
  }
  return null;
}

function labelValue(text: string, label: RegExp): { value: string; labelled: boolean } | null {
  const labelled = label.exec(text);
  if (labelled) return { value: labelled[1].trim(), labelled: true };
  return null;
}

function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  // "4400 Congress Ave, Austin TX 78701" — a two-letter state and a five-digit ZIP say United States.
  const us = /^(.+?),\s*([^,]+?)[,\s]+([A-Z]{2})\s+(\d{5})(?:[-\s](\d{4}))?/.exec(s);
  if (us) return { line1: us[1].trim(), city: us[2].trim(), state: us[3], postalCode: us[4], countryCode: 'US' };
  // "12 Old Street, London EC1R 1PG" — a postcode of that shape says United Kingdom. What counts as a
  // postal code is the profile's answer (rules/jurisdictions.yaml); this only reads the label, the gate
  // still checks the delivery address against the debtor's billing address.
  const gb = /^(.+?),\s*([^,]+?)[,\s]+([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i.exec(s);
  if (gb) return { line1: gb[1].trim(), city: gb[2].trim(), postalCode: gb[3].trim().toUpperCase(), countryCode: 'GB' };
  return null;
}

/** Deterministic field parser. No model, no network, same input always gives the same output. */
export function extractDeterministic(text: string): { pod: EvidenceBundle['pod']; invoiceHints: Extraction['invoiceHints']; confidence: Record<string, number> } {
  const confidence: Record<string, number> = {};
  const pod: EvidenceBundle['pod'] = { present: true, readable: true };
  const invoiceHints: Extraction['invoiceHints'] = {};

  const carrier = ALL_CARRIERS.find((c) => c.match.test(text));
  if (carrier) pod.carrier = carrier.name;

  const tracking = labelValue(text, /(?:tracking(?:\s*number)?|waybill(?:\s*number)?)\s*[:#]?\s*([A-Z0-9]{8,})/i);
  if (tracking) {
    pod.trackingNumber = tracking.value;
    confidence.trackingNumber = 0.95;
  }

  if (/status\s*[:#]?\s*delivered/i.test(text) || /^\s*delivered\b/i.test(text) || /delivered on/i.test(text)) {
    pod.delivered = true;
    confidence.delivered = 0.95;
  }

  const delivered = labelValue(text, /^[ \t]*delivered(?:\s+on)?\s*[:#][ \t]*([^\n]+)$/im)
    ?? labelValue(text, /\bdelivered\s+on\s+([^\n]+)/i);
  if (delivered) {
    const date = parseDate(delivered.value.replace(/\s+at\s+.*$/i, ''));
    if (date) {
      pod.deliveredOn = date;
      confidence.deliveredOn = 0.93;
    }
  }

  const consignee = labelValue(text, /consignee\s*[:\-]\s*([^\n]+)/i);
  if (consignee) {
    pod.consigneeName = consignee.value.replace(/\s{2,}/g, ' ').trim();
    confidence.consigneeName = 0.95;
  }

  const shipTo = labelValue(text, /ship\s*to\s*[:\-]\s*([^\n]+)/i);
  if (shipTo) {
    const address = parseAddress(shipTo.value);
    if (address) {
      pod.deliveryAddress = address;
      confidence.deliveryAddress = 0.91;
    }
  }

  pod.hasSignature = /signed\s+by\s*[:\-]\s*\S+/i.test(text) || /signature\s+(?:captured|on file)/i.test(text);
  confidence.hasSignature = /signed\s+by\s*[:\-]\s*\S+/i.test(text) ? 0.94 : 0.6;
  pod.hasPhoto = /photo\s+(?:attached|captured)|image on file/i.test(text);

  const po = labelValue(text, /(?:customer\s+)?p\.?o\.?\s*(?:number|ref|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (po) {
    pod.poRef = po.value;
    invoiceHints.poRef = po.value;
    confidence.poRef = 0.9;
  }

  const inv = labelValue(text, /invoice\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})/i);
  if (inv) invoiceHints.invoiceNumber = inv.value;

  return { pod, invoiceHints, confidence };
}

const SCHEMA_PROMPT = `You extract fields from a proof-of-delivery or delivery receipt. Reply with JSON only, no prose, no code fences.

{
  "carrier": string|null,
  "trackingNumber": string|null,
  "delivered": boolean|null,
  "deliveredOn": "YYYY-MM-DD"|null,
  "consigneeName": string|null,
  "deliveryAddress": { "line1": string, "city": string, "state": string, "postalCode": string, "countryCode": string }|null,
  "hasSignature": boolean,
  "hasPhoto": boolean,
  "poRef": string|null,
  "invoiceNumber": string|null,
  "confidence": { "trackingNumber": 0-1, "consigneeName": 0-1, "deliveredOn": 0-1, "deliveryAddress": 0-1, "hasSignature": 0-1, "delivered": 0-1 }
}

Rules: copy values as printed, do not infer. If a field is absent, use null and set its confidence to 0. Give confidence 1.0 only when the value is printed under an explicit label. Date in YYYY-MM-DD.`;

// For a photograph of paper there is no text layer to hand the readers, so the model is asked for
// the transcription as well as the fields. The transcription then goes through the same two readers
// as any other document, which keeps the deterministic parser in the loop: a field the model invents
// is absent from its own transcription and the parser says so.
const VISION_PROMPT = `${SCHEMA_PROMPT}

The document is a photograph of a printed delivery receipt: read the printed labels, the handler's
stamp and the signature line. Add one extra key to the JSON:

  "transcription": the printed lines, verbatim, one per line, in the order they appear

Transcribe what is printed. Do not clean up, complete or correct it.`;

export class ModelUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelUnavailable';
    this.code = code;
  }
}

/** One configured reader. The primary reads every document; the second reads only photographs. */
export interface ReaderRoute {
  base: string;
  key: string;
  model: string;
}

const primaryRoute = (): ReaderRoute | null =>
  config.geminiKey && config.geminiBase && config.geminiModel
    ? { base: config.geminiBase, key: config.geminiKey, model: config.geminiModel }
    : null;

const secondRoute = (): ReaderRoute | null =>
  config.extractBKey && config.extractBBase && config.extractBModel
    ? { base: config.extractBBase, key: config.extractBKey, model: config.extractBModel }
    : null;

// The free reader tier allows one successful request a minute per account. Remember the window so
// a burst of submissions does not spend its minute on 429s; the deterministic parser still answers.
let modelReadyAt = 0;

export async function extractWithModel(text: string): Promise<Extraction | null> {
  const route = primaryRoute();
  if (!route) return null;
  const { parsed, version } = await callChat(SCHEMA_PROMPT, `Document text:\n\n${text.slice(0, 12_000)}`, 'model pass', route);
  return fromParsed(parsed, version, text, route);
}

/** One chat call, with the free tier's cadence remembered so a burst does not spend its minute on 429s. */
async function callChat(systemPrompt: string, content: string | unknown[], label: string, route: ReaderRoute): Promise<{ parsed: any; version: string }> {
  // Only the primary reader is on the metered-by-the-minute free tier, so the cooldown guards it alone.
  if (route.model === config.geminiModel) {
    const wait = modelReadyAt - Date.now();
    if (wait > 0) {
      throw new ModelUnavailable('deferred', `${label} deferred: the free reader allows one request a minute, next attempt in ${Math.ceil(wait / 1000)}s; the label parser answered instead`);
    }
  }
  const body: Record<string, unknown> = {
    model: route.model,
    temperature: 0,
    max_tokens: 1400,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ]
  };
  // Measured 2026-10-30: a Nemotron route on the NVIDIA catalog answers with a null `content` and the
  // answer buried in `reasoning_content` unless thinking is switched off in the chat template.
  if (/integrate\.api\.nvidia\.com|nemotron/i.test(route.base + route.model)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const res = await fetch(`${route.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) {
    const payload: any = await res.json().catch(() => null);
    if (res.status === 429 && route.model === config.geminiModel) {
      const retry = Number(payload?.error?.retry_after_seconds ?? payload?.retry_after_seconds ?? res.headers.get('retry-after') ?? 60);
      const seconds = Number.isFinite(retry) && retry > 0 ? retry : 60;
      modelReadyAt = Date.now() + seconds * 1000;
      throw new ModelUnavailable('rate_limit', `${label} skipped: the free reader allows one request a minute, next attempt in ${seconds}s; the label parser answered instead`);
    }
    const code = payload?.error?.code ?? payload?.error?.type ?? '';
    throw new ModelUnavailable(`http_${res.status}`, `${label} failed: HTTP ${res.status}${code ? ' ' + code : ''}; the label parser answered instead`);
  }
  const payload: any = await res.json();
  const content2: string = payload?.choices?.[0]?.message?.content ?? '';
  const start = content2.indexOf('{');
  const end = content2.lastIndexOf('}');
  if (start < 0 || end < 0) throw new ModelUnavailable('no_json', `${label} failed: the reader returned no JSON; the label parser answered instead`);
  let parsed: any;
  try { parsed = JSON.parse(content2.slice(start, end + 1)); }
  catch { throw new ModelUnavailable('bad_json', `${label} failed: the reader returned malformed JSON; the label parser answered instead`); }
  return { parsed, version: String(payload?.model ?? route.model) };
}

function fromParsed(parsed: any, version: string, text: string, route: ReaderRoute | null = primaryRoute()): Extraction {
  const confidence: Record<string, number> = {};
  for (const f of FIELDS) {
    const c = Number(parsed?.confidence?.[f]);
    if (Number.isFinite(c)) confidence[f] = Math.max(0, Math.min(1, c));
  }
  const pod: EvidenceBundle['pod'] = {
    present: true,
    readable: true,
    carrier: parsed.carrier ?? undefined,
    trackingNumber: parsed.trackingNumber ?? undefined,
    delivered: typeof parsed.delivered === 'boolean' ? parsed.delivered : undefined,
    deliveredOn: parsed.deliveredOn ? parseDate(String(parsed.deliveredOn)) ?? undefined : undefined,
    consigneeName: parsed.consigneeName ?? undefined,
    deliveryAddress: parsed.deliveryAddress ?? undefined,
    hasSignature: !!parsed.hasSignature,
    hasPhoto: !!parsed.hasPhoto,
    poRef: parsed.poRef ?? undefined,
    confidence
  };
  return {
    model: route?.model ?? 'none',
    modelVersion: version,
    text,
    pod,
    invoiceHints: { invoiceNumber: parsed.invoiceNumber ?? undefined, poRef: parsed.poRef ?? undefined },
    confidence,
    notes: [],
    raw: parsed
  };
}

/** Reads a photograph of a document. One call returns the transcription and the fields. */
async function readImageWithModel(bytes: Buffer, mime: string, route: ReaderRoute): Promise<{ parsed: any; version: string }> {
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  return callChat(
    VISION_PROMPT,
    [
      { type: 'text', text: 'Photograph of the delivery receipt attached.' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ],
    'vision pass',
    route
  );
}

/**
 * A document with no text layer. When two readers are configured they both open the photograph, and
 * their field answers are reconciled with the same three-case rule as everywhere else, so no field
 * survives on one model's word. The label parser then runs over the primary reader's transcription:
 * it is independent of that reader's *mapping* — a value its field pass invents is absent from its own
 * transcription and the parser says so — while the second reader is independent of it all the way down
 * to the pixels.
 */
export function mergeVisionRead(parsed: any, version: string, image: { mime: string; bytes: number }, unavailable?: string, second?: { parsed: any; version: string; model?: string; failed?: string }): Extraction {
  const transcription = String(parsed?.transcription ?? '').trim();
  if (!transcription) {
    return {
      model: 'none', modelVersion: '-', text: '', confidence: {}, invoiceHints: {},
      notes: [unavailable ?? 'the vision pass returned no transcription'],
      pod: { present: true, readable: false }, raw: { image }
    };
  }
  const model = fromParsed(parsed, version, transcription);
  const both = second?.parsed
    ? reconcilePixels(model, fromParsed(second.parsed, second.version,
        String(second.parsed?.transcription ?? '').trim() || transcription,
        { base: '', key: '', model: second.model ?? 'second reader' }))
    : model;
  if (second?.failed) both.notes.unshift(second.failed);
  const det = extractDeterministic(transcription);
  const merged = reconcile(both, det, transcription, unavailable);
  merged.notes.unshift('the text layer came from the vision pass over this photograph, not from the file');
  merged.raw = {
    ...(merged.raw as object),
    source: 'vision',
    image,
    second: second?.parsed ?? second?.failed ?? (secondRoute() ? null : 'no second reader is configured')
  };
  return merged;
}

export async function extractImageEvidence(bytes: Buffer, mime: string): Promise<Extraction> {
  const image = { mime, bytes: bytes.length };
  const route = primaryRoute();
  if (!route) return mergeVisionRead(null, '-', image, 'no vision reader is configured');
  const other = secondRoute();
  let unavailable: string | undefined;
  const read = await readImageWithModel(bytes, mime, route).catch((err) => {
    unavailable = err instanceof ModelUnavailable ? err.message : 'vision extraction unavailable; no text layer to parse';
    return null;
  });
  if (!read) return mergeVisionRead(null, '-', image, unavailable);
  if (!other) return mergeVisionRead(read.parsed, read.version, image, unavailable);
  // A second reader of the same photograph, in a different weight family, asked at the same time.
  let second: { parsed: any; version: string; failed?: string } | undefined;
  const otherRead = await readImageWithModel(bytes, mime, other).catch((err) => {
    second = { parsed: null, version: '-', failed: err instanceof ModelUnavailable ? err.message : 'second vision reader unavailable' };
    return null;
  });
  if (otherRead) second = { parsed: otherRead.parsed, version: otherRead.version, model: other.model };
  return mergeVisionRead(read.parsed, read.version, image, unavailable, second);
}

/**
 * The same three-case rule the model/parser comparison uses, applied between two model reads of the
 * same photograph: agreement keeps the higher confidence, a field only one reader found is kept at
 * 0.75, a field they split on is halved — which puts it under the floor the gate will not pass on.
 */
export function reconcilePixels(a: Extraction, b: Extraction): Extraction {
  const merged = mergeReadings(a, b, a.model, b.model);
  return {
    model: `${a.model} + ${b.model}`,
    modelVersion: `${a.modelVersion}/${b.modelVersion}`,
    text: a.text,
    pod: merged.pod,
    invoiceHints: merged.invoiceHints,
    confidence: merged.confidence,
    verdicts: merged.confidence,
    notes: [`two independent reads of the photograph (${a.model} and ${b.model})`, ...merged.notes],
    raw: { pixels: [a.raw, b.raw], readers: [a.model, b.model] }
  };
}

const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** One reader's answer: fields, the confidence it gave each one, and the invoice references it saw. */
interface Reading {
  pod: EvidenceBundle['pod'];
  confidence: Record<string, number>;
  invoiceHints: Extraction['invoiceHints'];
  verdicts?: Record<string, number>;
}

/**
 * Compares two readings of the same document. Agreement keeps the higher confidence; a field only one
 * reader saw is kept at 0.75; a field they disagree on is halved, which for the 0.7 floor means a
 * disagreement is a refusal rather than a coin toss. The same rule is applied twice when a document is
 * photographed: between the two models that read its pixels, and then between what they settled on and
 * what the label parser found in the transcription.
 *
 * `prior` is what the earlier comparison already decided, field by field. A field the pixel readers
 * split on stays split: a later reader agreeing with one of them is not evidence about the other's
 * photograph, so the worse verdict is the one that stands.
 */
function mergeReadings(left: Reading, right: Reading, leftName: string, rightName: string, prior?: Record<string, number>): { pod: EvidenceBundle['pod']; confidence: Record<string, number>; notes: string[]; invoiceHints: Extraction['invoiceHints'] } {
  const confidence: Record<string, number> = {};
  const notes: string[] = [];
  const pod: EvidenceBundle['pod'] = { ...left.pod };

  const settle = (field: string, v: number) => {
    const before = Number(prior?.[field]);
    confidence[field] = Number.isFinite(before) ? Math.min(v, before) : v;
  };

  const pick = (field: string, a: unknown, b: unknown, apply: (v: any) => void) => {
    const ca = Number(left.confidence[field] ?? 0);
    const cb = Number(right.confidence[field] ?? 0);
    if (a == null && b == null) return;
    if (a != null && b != null) {
      if (norm(a) === norm(b)) { settle(field, Math.max(ca, cb)); return; }
      settle(field, Math.min(ca, cb) / 2);
      notes.push(`${field}: readers disagree (${leftName} "${String(a)}", ${rightName} "${String(b)}")`);
      apply(a);
      return;
    }
    // A value only one reader saw is kept but discounted to 0.75 whichever reader saw it. A model's
    // own confidence cannot vouch for itself: the second reader is the corroboration, and its absence
    // is the finding. Dropping the value instead would read as "unreadable", which is worse.
    settle(field, 0.75);
    notes.push(`${field}: found by ${a != null ? leftName : rightName} only (no value from ${a != null ? rightName : leftName})`);
    apply(a != null ? a : b);
  };

  pick('trackingNumber', left.pod.trackingNumber, right.pod.trackingNumber, (v) => { pod.trackingNumber = v; });
  pick('consigneeName', left.pod.consigneeName, right.pod.consigneeName, (v) => { pod.consigneeName = v; });
  pick('deliveredOn', left.pod.deliveredOn, right.pod.deliveredOn, (v) => { pod.deliveredOn = v; });
  pick('hasSignature', left.pod.hasSignature, right.pod.hasSignature, (v) => { pod.hasSignature = v; });
  pick('delivered', left.pod.delivered, right.pod.delivered, (v) => { pod.delivered = v; });
  const flat = (a?: Address) => (a ? `${a.line1} ${a.city} ${a.postalCode}` : null);
  const addrLeft = flat(left.pod.deliveryAddress);
  const addrRight = flat(right.pod.deliveryAddress);
  pick('deliveryAddress', addrLeft, addrRight, (v) => {
    pod.deliveryAddress = v === addrLeft ? left.pod.deliveryAddress : right.pod.deliveryAddress;
  });
  if (pod.deliveryAddress && right.pod.deliveryAddress && !pod.deliveryAddress.countryCode) {
    pod.deliveryAddress.countryCode = right.pod.deliveryAddress.countryCode;
  }

  if (!left.pod.carrier && right.pod.carrier) pod.carrier = right.pod.carrier;
  if (left.pod.hasPhoto == null && right.pod.hasPhoto) pod.hasPhoto = right.pod.hasPhoto;
  if (!pod.poRef && right.pod.poRef) pod.poRef = right.pod.poRef;
  // Canonicalise the carrier name against the profile the document's own address implies, so a Royal
  // Mail receipt is written up as Royal Mail rather than left as whatever the reader printed. The gate
  // still resolves the profile from the debtor's billing address, which is what actually decides.
  const docCountry = pod.deliveryAddress?.countryCode ?? right.pod.deliveryAddress?.countryCode;
  pod.carrier = canonicalCarrier(pod.carrier ?? right.pod.carrier, jurisdictionFor(docCountry)) ?? pod.carrier;

  pod.confidence = confidence;
  return {
    pod,
    confidence,
    notes,
    invoiceHints: {
      invoiceNumber: left.invoiceHints.invoiceNumber ?? right.invoiceHints.invoiceNumber,
      poRef: left.invoiceHints.poRef ?? right.invoiceHints.poRef
    }
  };
}

/**
 * Merges the model read with the deterministic label parser. `reconcilePixels` uses the same
 * comparison one step earlier, between two models; this is the step every document goes through.
 */
export function reconcile(model: Extraction | null, det: ReturnType<typeof extractDeterministic>, text: string, unavailable?: string): Extraction {
  if (!model) {
    return {
      model: 'deterministic-text',
      modelVersion: '1',
      text,
      pod: { ...det.pod, confidence: det.confidence },
      invoiceHints: det.invoiceHints,
      confidence: det.confidence,
      notes: [unavailable ?? 'model extraction unavailable; deterministic label parser only'],
      raw: { text }
    };
  }
  const merged = mergeReadings(model, det, model.model, 'label parser', model.verdicts);
  return {
    model: model.model,
    modelVersion: model.modelVersion,
    text,
    pod: merged.pod,
    invoiceHints: merged.invoiceHints,
    confidence: merged.confidence,
    verdicts: merged.confidence,
    notes: [...model.notes, ...merged.notes],
    // Both readings are kept, not just the reconciled one: the deal room shows the two columns the
    // desk compared, so a reviewer can see the disagreement rather than take its summary on trust.
    raw: { text, model: model.raw, modelPod: model.pod, deterministic: det }
  };
}

/** Text layer of a PDF, or the decoded bytes of a text file. Empty string means no text layer. */
export async function documentText(bytes: Buffer, mime: string): Promise<string> {
  if (mime === 'application/pdf') {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // pdfjs returns positioned runs, not lines. Rebuild lines from the baseline so labels and
      // their values stay together; joining everything with spaces merges the whole page into one.
      const lines: string[] = [];
      let current: string[] = [];
      let lastY: number | null = null;
      for (const item of content.items as any[]) {
        const y = Number(item?.transform?.[5]);
        if (lastY !== null && Number.isFinite(y) && Math.abs(y - lastY) > 2) {
          lines.push(current.join(' ').trim());
          current = [];
        }
        if (typeof item?.str === 'string') current.push(item.str);
        if (Number.isFinite(y)) lastY = y;
      }
      lines.push(current.join(' ').trim());
      pages.push(lines.filter(Boolean).join('\n'));
    }
    return pages.join('\n').trim();
  }
  return bytes.toString('utf8').trim();
}

export async function extractEvidence(bytes: Buffer, mime: string): Promise<Extraction> {
  if (mime === 'image/png' || mime === 'image/jpeg') return extractImageEvidence(bytes, mime);
  let text = '';
  try { text = await documentText(bytes, mime); } catch { text = ''; }
  if (!text) {
    return {
      model: 'none', modelVersion: '-', text: '', confidence: {}, invoiceHints: {}, notes: ['no text layer'],
      pod: { present: true, readable: false }, raw: {}
    };
  }
  const det = extractDeterministic(text);
  let unavailable: string | undefined;
  const model = await extractWithModel(text).catch((err) => {
    unavailable = err instanceof ModelUnavailable ? err.message : 'model extraction unavailable; deterministic label parser only';
    return null;
  });
  return reconcile(model, det, text, unavailable);
}
