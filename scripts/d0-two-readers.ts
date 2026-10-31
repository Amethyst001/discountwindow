// Live proof of the two-reader vision path: the same photograph opened by two models in different
// weight families, reconciled with each other and then with the deterministic label parser over the
// transcription. Writes the raw reads to evidence/published/ so the published claim can be re-read.
import fs from 'node:fs';
import path from 'node:path';
import { config, assertSandbox } from '../src/config.ts';
import { extractImageEvidence } from '../src/extract.ts';

const file = process.argv[2] ?? 'temp/scanned-pod-verified.jpg';
const target = process.argv[3] ?? 'evidence/published/x9-two-reader-vision.json';
const bytes = fs.readFileSync(file);
const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';

assertSandbox();
console.log(`image          ${file} (${bytes.length} bytes, ${mime})`);
console.log(`reader A       ${config.geminiModel} @ ${config.geminiBase}`);
console.log(`reader B       ${config.extractBModel ?? '(not configured)'} @ ${config.extractBBase ?? '-'}`);

const started = Date.now();
const out = await extractImageEvidence(bytes, mime);
const elapsedMs = Date.now() - started;

const pixels: any[] = (out.raw as any)?.model?.pixels ?? [];
const readers: string[] = (out.raw as any)?.model?.readers ?? [out.model];
const fields = ['trackingNumber', 'consigneeName', 'deliveredOn', 'deliveryAddress', 'hasSignature', 'delivered'];

console.log(`\nelapsed        ${elapsedMs} ms for ${readers.length} reader(s) plus the label parser`);
console.log(`model row      ${out.model}`);
console.log(`readable       ${out.pod.readable}`);

const head = ['field', ...readers.map((r) => r.split('/').pop()!), 'parser', 'used', 'confidence'];
const rows = fields.map((f) => {
  const fromPixel = (raw: any) => {
    const v = raw?.[f];
    return typeof v === 'object' && v ? [v.line1, v.city, v.postalCode, v.countryCode].filter(Boolean).join(' ') : String(v ?? '-');
  };
  const used = f === 'deliveryAddress'
    ? [out.pod.deliveryAddress?.line1, out.pod.deliveryAddress?.city, out.pod.deliveryAddress?.postalCode].filter(Boolean).join(' ')
    : String((out.pod as any)[f] ?? '-');
  return [
    f,
    ...pixels.map((p) => fromPixel(p)),
    fromPixel((out.raw as any).deterministic?.pod ?? {}),
    used,
    `${Math.round((out.confidence[f] ?? 0) * 100)}%`
  ];
});
const widths = head.map((_, i) => Math.max(...[head, ...rows].map((r) => String(r[i] ?? '').length)));
for (const line of [head, ...rows]) console.log(line.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd());

console.log('\nnotes');
for (const n of out.notes) console.log(`  - ${n}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({
  generatedAt: new Date().toISOString(),
  image: { file, mime, bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') },
  readers: { a: { model: config.geminiModel, base: config.geminiBase }, b: config.extractBModel ? { model: config.extractBModel, base: config.extractBBase } : null },
  elapsedMs,
  model: out.model,
  perReaderRaw: pixels,
  labelParser: (out.raw as any).deterministic,
  used: out.pod,
  confidence: out.confidence,
  verdicts: out.verdicts ?? null,
  notes: out.notes
}, null, 2));
console.log(`\nwrote          ${target}`);
