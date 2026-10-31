import test from 'node:test';
import assert from 'node:assert/strict';
import { runGate, namesMatch, addressesMatch, trackingIsValid, normalizeName, normaliseTracker, type EvidenceBundle } from '../src/gate.ts';

const debtor = {
  id: 'd1',
  legalName: 'Halcyon Retail Group',
  aliases: ['Halcyon Retail', 'Halcyon Group'],
  billingAddress: { line1: '4400 Congress Avenue', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' }
};

function bundle(overrides: Partial<EvidenceBundle> = {}, podOverrides: Partial<EvidenceBundle['pod']> = {}): EvidenceBundle {
  return {
    pod: {
      present: true, readable: true, carrier: 'FedEx', trackingNumber: '770123456789',
      delivered: true, deliveredOn: '2026-09-22', consigneeName: 'Halcyon Retail Group',
      deliveryAddress: { line1: '4400 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' },
      hasSignature: true, hasPhoto: false, poRef: 'PO-88421',
      confidence: { trackingNumber: 0.97, consigneeName: 0.95 },
      ...podOverrides
    },
    invoice: {
      invoiceNumber: 'A-1042', totalCents: 4800000, issuedOn: '2026-09-24', dueOn: '2026-11-23', poRef: 'PO-88421',
      lineItems: [{ description: 'goods', cents: 4800000 }]
    },
    debtor,
    evidenceSha256: 'a'.repeat(64),
    reusedEvidence: false,
    alreadyFinanced: false,
    protection: { status: 'ELIGIBLE', trackerId: '770123456789' },
    ...overrides
  };
}

const opts = { sandbox: true, allowProtectionOverride: false };

test('a clean bundle verifies on all eleven checks', () => {
  const out = runGate(bundle(), opts);
  assert.equal(out.verdict, 'VERIFIED');
  assert.equal(out.checks.length, 11);
  assert.deepEqual(out.checks.map((c) => c.checkId), ['E00','E01','E02','E03','E04','E05','E06','E07','E08','E09','E10']);
});

test('a consignee that only shares the first word is refused', () => {
  // The alias "Halcyon Group" normalises to the single token "halcyon". A subset rule would have
  // matched every consignee starting with Halcyon, including a different company entirely.
  assert.equal(namesMatch('Halcyon Logistics', 'Halcyon Retail Group', ['Halcyon Retail', 'Halcyon Group']), false);
  const out = runGate(bundle({}, { consigneeName: 'Halcyon Logistics' }), opts);
  assert.equal(out.verdict, 'REFUSED');
  assert.deepEqual(out.refusals.map((r) => r.code), ['CONSIGNEE_MISMATCH']);
  assert.equal(out.refusals[0].checkId, 'E04');
});

test('a genuine alias still passes', () => {
  assert.equal(namesMatch('Halcyon Retail', 'Halcyon Retail Group', ['Halcyon Retail']), true);
  assert.equal(namesMatch('HALCYON RETAIL GROUP LLC', 'Halcyon Retail Group', []), true);
});

test('a missing proof of delivery produces exactly one refusal, not a cascade', () => {
  const out = runGate(bundle({}, { present: false, readable: false }), opts);
  assert.equal(out.verdict, 'REFUSED');
  assert.deepEqual(out.refusals.map((r) => r.code), ['POD_MISSING']);
  const dependent = out.checks.filter((c) => ['E02','E03','E04','E05','E10'].includes(c.checkId));
  assert.equal(dependent.length, 5);
  for (const c of dependent) {
    assert.equal(c.passed, false);
    assert.equal(c.refusalCode, null);
    assert.match(c.detail, /Not evaluated/);
  }
});

test('each refusal code can be produced in isolation', () => {
  const cases: [string, EvidenceBundle, string][] = [
    ['PROTECTION_INELIGIBLE', bundle({ protection: { status: 'NOT_ELIGIBLE' } }), 'PROTECTION_INELIGIBLE'],
    ['TRACKING_INVALID', bundle({}, { carrier: 'UPS', trackingNumber: 'ABC' }), 'TRACKING_INVALID'],
    ['NOT_DELIVERED', bundle({}, { delivered: false }), 'NOT_DELIVERED'],
    ['DELIVERY_DATE_OUT_OF_WINDOW', bundle({}, { deliveredOn: '2026-05-01' }), 'DELIVERY_DATE_OUT_OF_WINDOW'],
    ['ADDRESS_MISMATCH', bundle({}, { deliveryAddress: { line1: '1 Elsewhere Rd', city: 'Austin', state: 'TX', postalCode: '78701' } }), 'ADDRESS_MISMATCH'],
    ['EVIDENCE_REUSED', bundle({ reusedEvidence: true }), 'EVIDENCE_REUSED'],
    ['TRACKER_REUSED', bundle({ reusedTracker: true }), 'TRACKER_REUSED'],
    ['INVOICE_ALREADY_FINANCED', bundle({ alreadyFinanced: true }), 'INVOICE_ALREADY_FINANCED'],
    ['NO_SIGNATURE_EVIDENCE', bundle({}, { hasSignature: false, hasPhoto: false }), 'NO_SIGNATURE_EVIDENCE']
  ];
  for (const [name, b, code] of cases) {
    const out = runGate(b, opts);
    assert.equal(out.verdict, 'REFUSED', name);
    assert.deepEqual(out.refusals.map((r) => r.code), [code], name);
  }
});

test('arithmetic and terms refusals', () => {
  const badTotal = bundle();
  badTotal.invoice.lineItems = [{ description: 'goods', cents: 4000000 }];
  assert.deepEqual(runGate(badTotal, opts).refusals.map((r) => r.code), ['AMOUNT_MISMATCH']);

  const badTerms = bundle();
  badTerms.invoice.issuedOn = '2026-09-24';
  badTerms.invoice.dueOn = '2026-09-30';
  badTerms.invoice.dueOn = '2026-08-01';
  assert.deepEqual(runGate(badTerms, opts).refusals.map((r) => r.code), ['TERMS_INVALID']);

  const longTenor = bundle();
  longTenor.invoice.issuedOn = '2026-01-01';
  longTenor.invoice.dueOn = '2026-06-01';
  longTenor.pod.deliveredOn = '2025-12-20';
  assert.ok(runGate(longTenor, opts).refusals.some((r) => r.code === 'DELIVERY_DATE_OUT_OF_WINDOW' || r.code === 'TERMS_INVALID'));
});

test('the sandbox override records itself and never claims a pass', () => {
  const b = bundle({ protection: { status: 'NOT_ELIGIBLE' } });
  const out = runGate(b, { sandbox: true, allowProtectionOverride: true });
  assert.equal(out.verdict, 'VERIFIED');
  assert.equal(out.overrides.length, 1);
  assert.equal(out.overrides[0].rawStatus, 'NOT_ELIGIBLE');
  const e00 = out.checks.find((c) => c.checkId === 'E00')!;
  assert.equal(e00.override, true);
  assert.match(e00.detail, /overridden, not passed/i);
});

test('the override is unavailable outside the sandbox', () => {
  const b = bundle({ protection: { status: 'NOT_ELIGIBLE' } });
  const out = runGate(b, { sandbox: false, allowProtectionOverride: true });
  assert.equal(out.verdict, 'REFUSED');
  assert.deepEqual(out.refusals.map((r) => r.code), ['PROTECTION_INELIGIBLE']);
  assert.equal(out.overrides.length, 0);
});

test('a sale with no rail transaction behind it is an absence, not a pass and not an override', () => {
  const out = runGate(bundle({ protection: { status: 'NOT_ON_RAIL' } }), { sandbox: true, allowProtectionOverride: true });
  assert.equal(out.verdict, 'VERIFIED');
  assert.equal(out.railCorroborated, false);
  assert.equal(out.overrides.length, 0);
  const e00 = out.checks.find((c) => c.checkId === 'E00')!;
  assert.equal(e00.passed, true);
  assert.equal(e00.override, false);
  assert.match(e00.detail, /uncorroborated/i);
  assert.match(e00.detail, /one band lower/i);
});

test('a rail that answers nothing is refused, while a rail that was never asked is priced', () => {
  const silent = runGate(bundle({ protection: { status: 'UNKNOWN' } }), { sandbox: false, allowProtectionOverride: false });
  assert.deepEqual(silent.refusals.map((r) => r.code), ['PROTECTION_INELIGIBLE']);
  assert.equal(silent.railCorroborated, true);
  const notOnRail = runGate(bundle({ protection: { status: 'NOT_ON_RAIL' } }), { sandbox: false, allowProtectionOverride: false });
  assert.equal(notOnRail.verdict, 'VERIFIED');
  assert.equal(notOnRail.railCorroborated, false);
});

test('an adverse answer from the rail still refuses even when the seller could have declared absence', () => {
  const out = runGate(bundle({ protection: { status: 'NOT_ELIGIBLE' } }), { sandbox: false, allowProtectionOverride: false });
  assert.deepEqual(out.refusals.map((r) => r.code), ['PROTECTION_INELIGIBLE']);
});

test('low confidence is a refusal, never a guess', () => {
  const b = bundle({}, { confidence: { trackingNumber: 0.3, consigneeName: 0.95 } });
  const out = runGate(b, opts);
  assert.deepEqual(out.refusals.map((r) => r.code), ['POD_UNREADABLE']);
});

test('tracking patterns are carrier aware', () => {
  assert.equal(trackingIsValid('UPS', '1Z999AA10123456784').ok, true);
  assert.equal(trackingIsValid('FedEx', '770123456789').ok, true);
  assert.equal(trackingIsValid('USPS', '9400111899223397234567').ok, true);
  assert.equal(trackingIsValid('UPS', '770123456789').ok, false);
  assert.equal(trackingIsValid(undefined, '770123456789').ok, false);
});

test('a tracker written by hand is the same parcel as one printed by a scanner', () => {
  // Labels are torn, re-typed and hyphenated. Two documents for one delivery must still be seen as
  // one delivery, and a well-formed number must not become TRACKING_INVALID for having separators.
  assert.equal(normaliseTracker('1z-999-aa1-0123-4567-84'), normaliseTracker('1Z999AA101234567 84'));
  assert.equal(trackingIsValid('UPS', '1z-999-aa1-0123-4567-84').ok, true);
  assert.equal(normaliseTracker('X'), null);
  assert.equal(normaliseTracker(undefined), null);

  const typed = runGate(bundle({}, { carrier: 'UPS', trackingNumber: '1z-999-aa1-0123-4567-84' }), opts);
  assert.equal(typed.verdict, 'VERIFIED');
  assert.match(typed.checks.find((c) => c.checkId === 'E06')!.detail, /both unique/);

  const reused = runGate(bundle({ reusedTracker: true }, { carrier: 'UPS', trackingNumber: '1z-999-aa1-0123-4567-84' }), opts);
  assert.deepEqual(reused.refusals.map((r) => r.code), ['TRACKER_REUSED']);
  assert.equal(reused.refusals[0].checkId, 'E06');
  assert.match(reused.checks.find((c) => c.checkId === 'E06')!.detail, /the parcel is not/);
});

test('address matching requires street, city and a five digit zip', () => {
  assert.equal(addressesMatch({ line1: '4400 Congress Avenue', city: 'Austin', postalCode: '78701-1234' }, debtor.billingAddress), true);
  assert.equal(addressesMatch({ line1: '4400 Congress Ave', city: 'Dallas', postalCode: '78701' }, debtor.billingAddress), false);
  assert.equal(addressesMatch(undefined, debtor.billingAddress), false);
});

test('a field read below the floor can lose a check but cannot win one', () => {
  const confident = { trackingNumber: 0.97, consigneeName: 0.95 };
  // Every case below is a bundle that would pass the check on the value alone. The confidence record
  // is the desk's own statement about how well it read that value, so the check is stopped by the
  // desk's uncertainty rather than by the number it happens to point at.
  const shaky: [string, Partial<EvidenceBundle['pod']>, Record<string, number>][] = [
    ['E03', { deliveredOn: '2026-09-22' }, { deliveredOn: 0.44 }],
    ['E03', { delivered: true }, { delivered: 0.3 }],
    ['E05', { deliveryAddress: { line1: '4400 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', countryCode: 'US' } }, { deliveryAddress: 0.38 }],
    ['E10', { hasSignature: true }, { hasSignature: 0.5 }]
  ];
  for (const [checkId, pod, confidence] of shaky) {
    const out = runGate(bundle({}, { ...pod, confidence: { ...confident, ...confidence } }), opts);
    assert.equal(out.verdict, 'REFUSED', checkId);
    assert.deepEqual(out.refusals.map((r) => r.code), ['POD_UNREADABLE'], checkId);
    assert.equal(out.refusals[0].checkId, checkId);
    assert.match(out.checks.find((c) => c.checkId === checkId)!.detail, /below the 70% floor the United States profile sets/);
  }
});

test('a low confidence absence keeps its own reason instead of becoming unreadable', () => {
  // The deterministic parser says "no signature line found" at 60%. That is a missing piece of
  // evidence, not an unreadable one, and the check names which.
  const out = runGate(bundle({}, { hasSignature: false, confidence: { trackingNumber: 0.97, consigneeName: 0.95, hasSignature: 0.6 } }), opts);
  assert.deepEqual(out.refusals.map((r) => r.code), ['NO_SIGNATURE_EVIDENCE']);
  assert.match(out.checks.find((c) => c.checkId === 'E10')!.detail, /Neither a signature nor a delivery photograph/);
  // And a photograph still stands on its own: the weak reading of the signature line is not what the
  // passing check rests on, so the floor does not touch it.
  const photographed = runGate(bundle({}, { hasSignature: false, hasPhoto: true, confidence: { trackingNumber: 0.97, consigneeName: 0.95, hasSignature: 0.6 } }), opts);
  assert.equal(photographed.verdict, 'VERIFIED');
  assert.match(photographed.checks.find((c) => c.checkId === 'E10')!.detail, /delivery photograph/);
});

test('an untrustworthy tracker is never quoted as unique', () => {
  // E06 rests on the file hash, which is a fact about the upload, so the check still passes. What it
  // is not allowed to do is claim the parcel number was compared when the reading of it is a guess.
  const out = runGate(bundle({}, { trackingNumber: '770123456789', confidence: { trackingNumber: 0.4, consigneeName: 0.95 } }), opts);
  assert.deepEqual(out.refusals.map((r) => r.code), ['POD_UNREADABLE']);
  const e06 = out.checks.find((c) => c.checkId === 'E06')!;
  assert.equal(e06.passed, true);
  assert.match(e06.detail, /the parcel was not compared/);
  assert.doesNotMatch(e06.detail, /both unique/);
});
