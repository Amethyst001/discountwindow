import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyToCents, formatCents, mulRate, toPayPalAmount } from '../src/money.ts';
import { priceSlice } from '../src/price.ts';
import { scoreDebtor, bandTerms } from '../src/score.ts';

test('money parses and formats without floating point', () => {
  assert.equal(parseMoneyToCents('1,234.56'), 123456);
  assert.equal(parseMoneyToCents('48,000.00'), 4800000);
  assert.equal(parseMoneyToCents('0.07'), 7);
  assert.equal(formatCents(4800000), '$48,000.00');
  assert.equal(formatCents(64357), '$643.57');
  assert.equal(formatCents(-1234), '-$12.34');
  assert.equal(toPayPalAmount(4800000), '48000');
  assert.equal(toPayPalAmount(64357), '643.57');
  assert.throws(() => parseMoneyToCents('12.345'));
});

test('rate multiplication rounds half up on integers', () => {
  assert.equal(mulRate(100, 1, 2), 50);
  assert.equal(mulRate(101, 1, 2), 51);
  assert.equal(mulRate(1, 1, 3), 0);
  assert.equal(mulRate(2, 1, 3), 1);
});

test('the pinned worked example reproduces to the cent', () => {
  const p = priceSlice({ faceCents: 4800000, shareBp: 6000, tenorDays: 60, band: 'B' });
  assert.equal(p.ok, true);
  assert.equal(p.annualRateBp, 1400);
  assert.equal(p.grossSliceCents, 2880000);
  assert.equal(p.feeReserveCents, 83550);
  assert.equal(p.netSliceCents, 2796450);
  assert.equal(p.discountCents, 64357);
  assert.equal(p.advanceCents, 2732093);
  assert.equal(p.platformFeeCents, 24000);
});

test('band limits refuse rather than silently size down', () => {
  assert.equal(priceSlice({ faceCents: 100000, shareBp: 7000, tenorDays: 30, band: 'C' }).ok, false);
  assert.equal(priceSlice({ faceCents: 100000, shareBp: 5000, tenorDays: 75, band: 'C' }).ok, false);
  assert.equal(priceSlice({ faceCents: 100000, shareBp: 5000, tenorDays: 30, band: 'D' }).ok, false);
});

test('the demo debtor scores 78 in band B', () => {
  const s = scoreDebtor({
    invoicesDue: 24, paidOnTime: 16, daysLateAverage: 4.2, outstandingCents: 6000000,
    limitCents: 30000000, monthsActive: 18, disputes: 0, totalInvoices: 26, faceCents: 4800000
  });
  assert.equal(s.score, 78);
  assert.equal(s.band, 'B');
});

test('score components always sum to the score', () => {
  const s = scoreDebtor({
    invoicesDue: 12, paidOnTime: 9, daysLateAverage: 7, outstandingCents: 1000000,
    limitCents: 10000000, monthsActive: 30, disputes: 1, totalInvoices: 20, faceCents: 500000
  });
  const sum = Object.values(s.components).reduce((a, c) => a + c.points, 0);
  assert.equal(sum, s.score);
});

const PRISTINE = {
  invoicesDue: 24, paidOnTime: 24, daysLateAverage: 0, outstandingCents: 0,
  limitCents: 30000000, monthsActive: 30, disputes: 0, totalInvoices: 24, faceCents: 100000
};

test('an uncorroborated sale cannot hold the band-A advance even on a perfect record', () => {
  assert.equal(scoreDebtor(PRISTINE).band, 'A');
  const demoted = scoreDebtor(PRISTINE, { railCorroborated: false });
  assert.equal(demoted.score, 100);
  assert.equal(demoted.band, 'B');
  assert.match(demoted.bandNote ?? '', /no PayPal transaction behind this invoice/i);
  // The whole point of the demotion: the advance ceiling and the tenor come from the band.
  assert.equal(bandTerms('A').maxAdvanceBp, 9000);
  assert.equal(bandTerms(demoted.band).maxAdvanceBp, 8000);
});

test('the cap does not invent one where the score already set the limit', () => {
  const weak = { ...PRISTINE, paidOnTime: 12, daysLateAverage: 14, disputes: 4, totalInvoices: 24 };
  const s = scoreDebtor(weak, { railCorroborated: false });
  assert.equal(s.band, scoreDebtor(weak).band);
  assert.equal(s.bandNote, undefined);
});
