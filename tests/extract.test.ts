import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeterministic, mergeVisionRead, reconcile, type Extraction } from '../src/extract.ts';

const POD = `PROOF OF DELIVERY
Carrier: UPS
Tracking Number: 1Z9X77W00381942201
Status: Delivered
Delivered on: 2026-10-27
Consignee: Juniper Packaging
Ship to: 505 SW Salmon St, Boise ID 83702
Signed by: R. Alvarez
Customer PO: PO-77120
Invoice: J-3901`;

function modelExtraction(overrides: Partial<Extraction['pod']> = {}, confidence: Record<string, number> = {}): Extraction {
  const det = extractDeterministic(POD);
  return {
    model: 'test-reader', modelVersion: '1', text: POD,
    pod: { ...det.pod, ...overrides, confidence },
    invoiceHints: det.invoiceHints,
    confidence,
    notes: [],
    raw: {}
  };
}

test('without a model the parser answers and the reason is kept verbatim', () => {
  const det = extractDeterministic(POD);
  const reason = 'model pass deferred: the free reader allows one request a minute, next attempt in 41s; the label parser answered instead';
  const out = reconcile(null, det, POD, reason);
  assert.equal(out.model, 'deterministic-text');
  assert.deepEqual(out.notes, [reason]);
  assert.equal(out.pod.trackingNumber, '1Z9X77W00381942201');
});

test('agreement keeps the higher confidence and adds no notes', () => {
  const det = extractDeterministic(POD);
  const model = modelExtraction({}, {
    trackingNumber: 0.99, consigneeName: 0.99, deliveredOn: 0.99, deliveryAddress: 0.99, hasSignature: 0.99, delivered: 0.99
  });
  const out = reconcile(model, det, POD);
  assert.equal(out.model, 'test-reader');
  assert.equal(out.notes.length, 0);
  assert.equal(out.confidence.trackingNumber, 0.99);
});

test('a disagreement halves confidence, which falls under the 0.7 threshold', () => {
  const det = extractDeterministic(POD);
  const model = modelExtraction({ consigneeName: 'Juniper Packaging Inc' }, { consigneeName: 0.98 });
  const out = reconcile(model, det, POD);
  assert.ok(out.confidence.consigneeName < 0.7, `got ${out.confidence.consigneeName}`);
  assert.match(out.notes.join('\n'), /consigneeName: readers disagree/);
});

test('a field only the parser saw is kept, discounted to 0.75, and survives the merge', () => {
  const det = extractDeterministic(POD);
  const model = modelExtraction({ trackingNumber: undefined }, {});
  const out = reconcile(model, det, POD);
  assert.equal(out.confidence.trackingNumber, 0.75);
  assert.equal(out.pod.trackingNumber, '1Z9X77W00381942201');
  assert.match(out.notes.join('\n'), /trackingNumber: found by .* only/);
});

const IMAGE = { mime: 'image/jpeg', bytes: 195_293 };

const visionParsed = (overrides: Record<string, unknown> = {}) => ({
  transcription: POD,
  carrier: 'UPS',
  trackingNumber: '1Z9X77W00381942201',
  delivered: true,
  deliveredOn: '2026-10-27',
  consigneeName: 'Juniper Packaging',
  deliveryAddress: { line1: '505 SW Salmon St', city: 'Boise', state: 'ID', postalCode: '83702', countryCode: 'US' },
  hasSignature: true,
  hasPhoto: false,
  poRef: 'PO-77120',
  invoiceNumber: 'J-3901',
  confidence: {
    trackingNumber: 0.99, consigneeName: 0.99, deliveredOn: 0.99,
    deliveryAddress: 0.99, hasSignature: 0.99, delivered: 0.99
  },
  ...overrides
});

test('a photographed receipt is read once, and the parser runs over that same transcription', () => {
  const out = mergeVisionRead(visionParsed(), 'vision-test', IMAGE);
  assert.equal(out.raw.source, 'vision');
  assert.deepEqual(out.raw.image, IMAGE);
  assert.equal(out.pod.readable, true);
  assert.equal(out.pod.trackingNumber, '1Z9X77W00381942201');
  assert.equal(out.confidence.trackingNumber, 0.99);
  assert.match(out.notes[0], /text layer came from the vision pass/);
});

test('a tracking number the field pass invents is not in its own transcription, so it is discounted', () => {
  const withoutTracking = POD.split('\n').filter((l) => !/Tracking Number/.test(l)).join('\n');
  const out = mergeVisionRead(visionParsed({ transcription: withoutTracking }), 'vision-test', IMAGE);
  assert.equal(out.confidence.trackingNumber, 0.75);
  assert.match(out.notes.join('\n'), /trackingNumber: found by .* only/);
});

test('a consignee the field pass restates is contradicted by the transcription and falls under the floor', () => {
  const out = mergeVisionRead(visionParsed({ consigneeName: 'Juniper Packaging Inc.' }), 'vision-test', IMAGE);
  assert.ok(out.confidence.consigneeName < 0.7, `got ${out.confidence.consigneeName}`);
  assert.match(out.notes.join('\n'), /consigneeName: readers disagree/);
});

test('a photograph with no transcription stays unreadable and keeps the reason', () => {
  const reason = 'vision pass failed: HTTP 503 system_cpu_overloaded; the label parser answered instead';
  const out = mergeVisionRead(null, '-', IMAGE, reason);
  assert.equal(out.pod.readable, false);
  assert.deepEqual(out.notes, [reason]);
  assert.deepEqual(out.raw.image, IMAGE);
});

test('a second reader of the same photograph is asked the same question and printed beside it', () => {
  const out = mergeVisionRead(visionParsed(), 'reader-a-1', IMAGE, undefined, {
    parsed: visionParsed(), version: 'reader-b-1', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b'
  });
  assert.match(out.model, /\+ nvidia\/nemotron-3\.5-super-vl-120b-a12b$/);
  assert.equal(out.pod.consigneeName, 'Juniper Packaging');
  assert.equal(out.confidence.consigneeName, 0.99, 'two readers that agree keep the higher confidence');
  assert.equal(out.raw.source, 'vision');
  assert.equal(out.raw.second.consigneeName, 'Juniper Packaging', 'the second reading is stored, not summarised');
});

test('two readers that split on a field do not let the label parser heal it', () => {
  const out = mergeVisionRead(visionParsed(), 'reader-a-1', IMAGE, undefined, {
    parsed: visionParsed({ consigneeName: 'Juniper Packaging Ltd' }), version: 'reader-b-1', model: 'reader-b'
  });
  // The parser reads the primary's own transcription, so it agrees with the primary by construction.
  // It cannot arbitrate a disagreement about the pixels, and it must not launder it back over the floor.
  assert.equal(out.verdicts.consigneeName, 0.495);
  assert.ok(out.confidence.consigneeName < 0.7, `got ${out.confidence.consigneeName}`);
  assert.match(out.notes.join('\n'), /consigneeName: readers disagree \([^\n]*"Juniper Packaging", reader-b "Juniper Packaging Ltd"\)/);
});

test('a second reader that is not there leaves the single-reader path with its reason on the record', () => {
  const failed = 'vision pass failed: HTTP 402 insufficient_credits; the label parser answered instead';
  const out = mergeVisionRead(visionParsed(), 'reader-a-1', IMAGE, undefined, { parsed: null, version: '-', failed });
  assert.match(out.notes.join('\n'), new RegExp(failed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(out.confidence.trackingNumber, 0.99);
  assert.equal(out.raw.second, failed, 'the desk keeps why the second reader did not answer');
});
