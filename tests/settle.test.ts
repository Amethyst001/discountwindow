import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { postFunding, postMaturity, accountBalance, unbalancedTransactions } from '../src/ledger.ts';
import { priceSlice, settlementSplit, paypalFeeOn } from '../src/price.ts';

// The NW-2277 fixture as priced on 2026-10-30: face 650.00, band B, 60-day tenor.
const price = priceSlice({ faceCents: 65_000, shareBp: 8000, tenorDays: 60, band: 'B' });

test('the maturity split pays the face exactly once, across the two payees', () => {
  const split = settlementSplit(65_000, {
    advance_cents: price.advanceCents,
    discount_cents: price.discountCents,
    fee_reserve_cents: price.feeReserveCents
  });
  assert.equal(split.grossFunderCents + split.grossSellerCents, 65_000);
  assert.equal(split.funderNetCents + split.sellerNetCents + split.feeCents, 65_000);
  assert.equal(split.grossFunderCents, Math.round(65_000 * 0.8), 'the funder holds the band-B share of face');
  assert.equal(split.funderNetCents, price.advanceCents + price.discountCents, 'the funder nets its advance plus the discount');
  assert.ok(split.funderYieldCents > 0, 'the funder is paid a yield, not a haircut');
  assert.ok(split.sellerNetCents > 0, 'the seller keeps the remainder');
});

test('the fee booked at maturity is the same fee the price reserved', () => {
  const split = settlementSplit(65_000, {
    advance_cents: price.advanceCents,
    discount_cents: price.discountCents,
    fee_reserve_cents: price.feeReserveCents
  });
  assert.equal(split.feeFunderCents, price.feeReserveCents);
  assert.equal(split.feeCents, paypalFeeOn(split.grossFunderCents) + paypalFeeOn(split.grossSellerCents));
});

test('a fee larger than a payee unit is capped, never negative', () => {
  const tiny = settlementSplit(100, { advance_cents: 50, discount_cents: 1, fee_reserve_cents: 45 });
  assert.equal(tiny.grossSellerCents, 4);
  assert.equal(tiny.feeSellerCents, 4);
  assert.equal(tiny.sellerNetCents, 0);
  assert.equal(tiny.grossFunderCents - tiny.feeFunderCents + tiny.sellerNetCents + tiny.feeCents, 100);
});

test('funding then maturity clears the funder outlay and leaves the face in clearing', () => {
  const db = openDb(':memory:');
  const split = settlementSplit(65_000, {
    advance_cents: price.advanceCents,
    discount_cents: price.discountCents,
    fee_reserve_cents: price.feeReserveCents
  });
  postFunding(db, 'inv-1', 'funder-demo', 'seller-1', {
    advanceCents: price.advanceCents,
    platformFeeCents: price.platformFeeCents
  });
  postMaturity(db, 'inv-1', 'funder-demo', 'seller-1', {
    faceCents: 65_000,
    paypalFeeCents: split.feeCents,
    funderOutlayCents: price.advanceCents,
    funderNetCents: split.funderNetCents,
    sellerNetCents: split.sellerNetCents
  });

  assert.equal(accountBalance(db, 'funder:funder-demo:outlay'), 0);
  assert.equal(accountBalance(db, 'funder:funder-demo:yield'), -price.discountCents);
  assert.equal(accountBalance(db, 'platform:clearing'), 65_000);
  assert.equal(accountBalance(db, 'seller:seller-1:proceeds'), -split.sellerNetCents);
  assert.deepEqual(unbalancedTransactions(db), []);
});

test('every band-B price the desk can produce settles without an unbalanced posting', () => {
  const db = openDb(':memory:');
  for (const face of [5_000, 12_345, 65_000, 480_000, 1_000_000]) {
    for (const tenor of [14, 44, 60, 90]) {
      const p = priceSlice({ faceCents: face, shareBp: 8000, tenorDays: tenor, band: 'B' });
      assert.ok(p.ok);
      const split = settlementSplit(face, {
        advance_cents: p.advanceCents, discount_cents: p.discountCents, fee_reserve_cents: p.feeReserveCents
      });
      const txn = `mature:${face}:${tenor}`;
      postMaturity(db, txn, 'f', 's', {
        faceCents: face,
        paypalFeeCents: split.feeCents,
        funderOutlayCents: p.advanceCents,
        funderNetCents: split.funderNetCents,
        sellerNetCents: split.sellerNetCents
      });
      assert.ok(split.funderYieldCents > 0, `face ${face} tenor ${tenor} yields a positive discount`);
    }
  }
  assert.deepEqual(unbalancedTransactions(db), []);
});
