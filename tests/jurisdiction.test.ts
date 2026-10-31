import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runGate, jurisdictionFor, trackingIsValid, addressesMatch, DEFAULT_JURISDICTION,
  JURISDICTION_CODES, type EvidenceBundle, type Address
} from '../src/gate.ts';

// The portability claim: the eleven checks are the same in every country and only the numbers move.
// These fixtures are deliberately identical except for the country on the billing address, so any
// difference in verdict is the profile's doing and not the document's.

const london: Address = { line1: '12 Old Street', city: 'London', postalCode: 'EC1R 1PG', countryCode: 'GB' };

function gbBundle(overrides: Partial<EvidenceBundle> = {}, podOverrides: Partial<EvidenceBundle['pod']> = {}): EvidenceBundle {
  return {
    pod: {
      present: true, readable: true, carrier: 'Royal Mail', trackingNumber: 'RB123456789GB',
      delivered: true, deliveredOn: '2026-10-20', consigneeName: 'MERIDIAN TRADING LIMITED',
      deliveryAddress: london, hasSignature: true, hasPhoto: false, poRef: 'PO-551',
      confidence: { trackingNumber: 0.96, consigneeName: 0.94 },
      ...podOverrides
    },
    invoice: {
      invoiceNumber: 'MT-2207', totalCents: 125000, issuedOn: '2026-10-24', dueOn: '2027-02-01', poRef: 'PO-551',
      lineItems: [{ description: 'goods', cents: 125000 }]
    },
    debtor: { id: 'g1', legalName: 'Meridian Trading Ltd', aliases: ['Meridian Trading'], billingAddress: london },
    evidenceSha256: 'b'.repeat(64),
    reusedEvidence: false,
    alreadyFinanced: false,
    protection: { status: 'ELIGIBLE', trackerId: 'RB123456789GB' },
    ...overrides
  };
}

/** The same paper, claimed to sit in the United States: only the country changes. */
function asUS(bundle: EvidenceBundle): EvidenceBundle {
  return {
    ...bundle,
    debtor: { ...bundle.debtor, billingAddress: { ...bundle.debtor.billingAddress, countryCode: 'US' } }
  };
}

const opts = { sandbox: true, allowProtectionOverride: false };

test('the rule set is data: two profiles are loaded and a country with no profile falls back', () => {
  assert.deepEqual(JURISDICTION_CODES, ['US', 'GB']);
  assert.equal(jurisdictionFor('gb').label, 'United Kingdom');
  assert.equal(jurisdictionFor('JP').label, DEFAULT_JURISDICTION.label);
  assert.equal(jurisdictionFor(undefined).label, 'United States');
});

test('one document verifies under the profile it belongs to', () => {
  const out = runGate(gbBundle(), opts);
  assert.equal(out.verdict, 'VERIFIED', JSON.stringify(out.refusals));
  assert.deepEqual(out.jurisdiction, { code: 'GB', label: 'United Kingdom' });
  assert.equal(out.checks.length, 11);
});

test('the same document refused by the United States profile is refused for profile reasons only', () => {
  const out = runGate(asUS(gbBundle()), opts);
  assert.equal(out.verdict, 'REFUSED');
  assert.deepEqual(out.refusals.map((r) => r.code).sort(), ['ADDRESS_MISMATCH', 'TERMS_INVALID', 'TRACKING_INVALID']);
  assert.match(out.refusals.find((r) => r.code === 'TRACKING_INVALID')!.rule, /carrier this desk recognises/i);
  // Nothing about the evidence changed: the name, the address, the dates and the arithmetic all still
  // pass. Only the tables the gate reads from changed.
  const passed = out.checks.filter((c) => c.passed).map((c) => c.checkId);
  assert.deepEqual(passed.filter((id) => ['E00', 'E01', 'E03', 'E04', 'E06', 'E07', 'E08', 'E10'].includes(id)),
    ['E00', 'E01', 'E03', 'E04', 'E06', 'E07', 'E08', 'E10']);
});

test('the numbers a profile owns move the verdict, and the rule sentence says which', () => {
  // A hundred-day tenor: inside the United Kingdom cap, outside the United States one.
  const long = gbBundle();
  assert.equal(runGate(long, opts).verdict, 'VERIFIED');
  const longUS = runGate(asUS(long), opts);
  const e09 = longUS.checks.find((c) => c.checkId === 'E09')!;
  assert.equal(e09.passed, false);
  assert.match(e09.detail, /Tenor is 100 days; the United States limit is 90/);

  // A delivery 75 days before the invoice: fresh enough for the United States, stale for the
  // United Kingdom, with nothing else about the parcel altered.
  const stale = gbBundle({}, { deliveredOn: '2026-08-10' });
  stale.invoice.issuedOn = '2026-10-24';
  stale.invoice.dueOn = '2026-11-23';
  assert.equal(runGate(stale, opts).refusals.map((r) => r.code).join(), 'DELIVERY_DATE_OUT_OF_WINDOW');
  assert.match(runGate(stale, opts).checks.find((c) => c.checkId === 'E03')!.detail,
    /Delivered 75 days before the invoice; the United Kingdom limit is 60/);
  const staleUS = runGate(asUS(stale), opts);
  assert.equal(staleUS.checks.find((c) => c.checkId === 'E03')!.passed, true);
});

test('rule sentences are rendered from the profile, not baked into the code', () => {
  const gb = runGate(gbBundle(), opts).checks;
  const us = runGate(asUS(gbBundle()), opts).checks;
  const byId = (cs: typeof gb, id: string) => cs.find((c) => c.checkId === id)!.rule;

  assert.match(byId(gb, 'E00'), /Purchase Protection/);
  assert.match(byId(us, 'E00'), /Seller Protection/);
  assert.match(byId(gb, 'E03'), /within 60 days/);
  assert.match(byId(us, 'E03'), /within 90 days/);
  assert.match(byId(gb, 'E09'), /no longer than 120 days/);
  assert.match(byId(us, 'E09'), /no longer than 90 days/);
  // The checks that carry no country-specific number read identically in both profiles.
  assert.equal(byId(gb, 'E06'), byId(us, 'E06'));
  assert.equal(byId(gb, 'E10'), byId(us, 'E10'));
});

test('the gate names the profile it decided under, so the page can show its numbers', () => {
  // A number the United States profile believes and the United Kingdom one does not: the refusal
  // says which desk made it, because which carriers are worth believing is a per-country answer.
  const out = runGate(gbBundle({}, { carrier: 'USPS', trackingNumber: '9400111899223397234567' }), opts);
  assert.equal(out.verdict, 'REFUSED');
  assert.equal(out.jurisdiction?.code, 'GB');
  assert.match(out.checks.find((c) => c.checkId === 'E02')!.detail, /not one the United Kingdom desk can verify/);
  assert.match(out.checks.find((c) => c.checkId === 'E05')!.detail, /United Kingdom postal-code rule/);
});

test('each profile only believes its own carriers and its own postal codes', () => {
  const gb = jurisdictionFor('GB');
  const us = jurisdictionFor('US');
  assert.equal(trackingIsValid('Royal Mail', 'RB123456789GB', gb).ok, true);
  assert.equal(trackingIsValid('Royal Mail', 'RB123456789GB', us).ok, false);
  assert.match(trackingIsValid('Royal Mail', 'RB123456789GB', us).reason, /not one the United States desk can verify/);
  assert.equal(trackingIsValid('Evri', 'H012345678901234', gb).ok, true);
  // Global formats survive the move: a FedEx number validates in both profiles.
  assert.equal(trackingIsValid('Fedex', '770123456789', gb).ok, true);
  assert.equal(trackingIsValid('DPD', '01234567891234', us).ok, false);

  assert.equal(addressesMatch(london, london, gb), true);
  assert.equal(addressesMatch({ ...london, postalCode: 'EC1R1PG' }, london, gb), true);
  assert.equal(addressesMatch({ ...london, postalCode: 'EC1R 1PX' }, london, gb), false);
  assert.equal(addressesMatch(london, london, us), false);

  // The United States keeps the five-digit prefix, so a ZIP+4 disagreement is still one address.
  const austin: Address = { line1: '4400 Congress Avenue', city: 'Austin', postalCode: '78701', countryCode: 'US' };
  assert.equal(addressesMatch({ ...austin, postalCode: '78701-1234' }, austin, us), true);
  assert.equal(addressesMatch({ ...austin, line1: '4400 Congress Ave' }, austin, us), true);
});
