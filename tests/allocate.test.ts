import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, centsFromPayPal } from '../src/paypal.ts';

/**
 * These fixtures are shaped after the responses measured on the sandbox on 2026-10-30:
 *
 * - A capture *resource* (`GET /v2/payments/captures/{id}`) reports `payee` as the PAYER, even for
 *   a split capture. For the funding order the payer is the funder.
 * - Capture objects nested inside an order/capture response omit both `amount` and `payee`.
 *
 * So a posting routine that reads payee or amount off the capture would pay the funder with the
 * funder's own money, and every happy-path test would still pass. `allocate` must read the units.
 */

const ORDER_ID = '5O190127TN364715T';
const PAYER = 'buyer@example.com';
const SELLER = 'seller@example.com';
const PLATFORM = 'platform@example.com';

function splitOrder() {
  return {
    id: ORDER_ID,
    status: 'COMPLETED',
    purchase_units: [
      {
        reference_id: 'seller',
        amount: { currency_code: 'USD', value: '0.90' },
        payee: { email_address: SELLER },
        payments: {
          captures: [
            { id: '8KU97245AM022784H', status: 'COMPLETED', seller_protection: { status: 'ELIGIBLE' } }
          ]
        }
      },
      {
        reference_id: 'platform',
        amount: { currency_code: 'USD', value: '0.10' },
        payee: { email_address: PLATFORM },
        payments: {
          captures: [
            { id: '0DJ389603U333234R', status: 'COMPLETED', seller_protection: { status: 'NOT_ELIGIBLE' } }
          ]
        }
      }
    ]
  };
}

/** The measured capture resource: payee is the payer, and there is no per-payee breakdown. */
function captureResource(captureId: string) {
  return {
    id: captureId,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '1.00' },
    payee: { email_address: PAYER, merchant_id: 'PAYER-MERCHANT' },
    supplementary_data: { related_ids: { order_id: ORDER_ID } }
  };
}

test('a split capture allocates to each unit payee, never to the payer', () => {
  const out = allocate(splitOrder(), ORDER_ID);
  assert.equal(out.allocations.length, 2);
  assert.deepEqual(out.allocations.map((a) => a.referenceId), ['seller', 'platform']);
  assert.deepEqual(out.allocations.map((a) => a.payeeEmail), [SELLER, PLATFORM]);
  assert.deepEqual(out.allocations.map((a) => a.amountCents), [90, 10]);
  assert.equal(out.allocations.some((a) => a.payeeEmail === PAYER), false, 'the payer is never a payee');
});

test('the payee the capture resource reports is ignored even when it contradicts the order', () => {
  const capture = captureResource('8KU97245AM022784H');
  assert.equal(capture.payee.email_address, PAYER);
  const out = allocate(splitOrder(), ORDER_ID);
  // The capture says the money went to the payer for $1.00; the order says $0.90 to the seller.
  const seller = out.allocations.find((a) => a.referenceId === 'seller')!;
  assert.equal(seller.payeeEmail, SELLER);
  assert.equal(seller.amountCents, 90);
});

test('a capture object with no amount or payee still yields the unit amount', () => {
  const order = splitOrder();
  const capture = order.purchase_units[0].payments.captures[0] as any;
  assert.equal('amount' in capture, false);
  assert.equal('payee' in capture, false);
  const out = allocate(order, ORDER_ID);
  assert.equal(out.allocations[0].amountCents, 90, 'the amount came from the unit, not the capture');
  assert.equal(out.allocations[0].captureId, '8KU97245AM022784H');
});

test('a three payee maturity split allocates every leg', () => {
  const order = {
    id: ORDER_ID,
    status: 'COMPLETED',
    purchase_units: [
      { reference_id: 'funder-a', amount: { value: '0.20' }, payee: { email_address: 'a@example.com' }, payments: { captures: [{ id: '3HL15889SJ722022X', status: 'COMPLETED' }] } },
      { reference_id: 'funder-b', amount: { value: '0.30' }, payee: { email_address: 'b@example.com' }, payments: { captures: [{ id: '43M97402UB703411Y', status: 'COMPLETED' }] } },
      { reference_id: 'seller', amount: { value: '0.50' }, payee: { email_address: SELLER }, payments: { captures: [{ id: '7D0883560J436545Y', status: 'COMPLETED' }] } }
    ]
  };
  const out = allocate(order, ORDER_ID);
  assert.deepEqual(out.allocations.map((a) => [a.referenceId, a.payeeEmail, a.amountCents]), [
    ['funder-a', 'a@example.com', 20],
    ['funder-b', 'b@example.com', 30],
    ['seller', SELLER, 50]
  ]);
});

test('a capture that belongs to a different order is refused', () => {
  const order = splitOrder();
  (order.purchase_units[0].payments.captures[0] as any).supplementary_data = { related_ids: { order_id: 'SOMEOTHERORDER00001' } };
  assert.throws(() => allocate(order, ORDER_ID), /belongs to order SOMEOTHERORDER00001/);
});

test('a unit with no payee email is refused rather than silently dropped', () => {
  const order = splitOrder();
  delete (order.purchase_units[1] as any).payee;
  assert.throws(() => allocate(order, ORDER_ID), /no payee email/);
});

test('a unit with no capture is refused', () => {
  const order = splitOrder();
  (order.purchase_units[1] as any).payments = { captures: [] };
  assert.throws(() => allocate(order, ORDER_ID), /has no capture/);
});

test('a capture resource cannot stand in for an order', () => {
  assert.throws(() => allocate(captureResource('8KU97245AM022784H'), ORDER_ID), /no purchase_units/);
});

test('PayPal decimal amounts become integer cents without float error', () => {
  assert.equal(centsFromPayPal('1.00'), 100);
  assert.equal(centsFromPayPal('0.90'), 90);
  assert.equal(centsFromPayPal('27320.93'), 2_732_093);
  assert.equal(centsFromPayPal('0.07'), 7);
  assert.equal(centsFromPayPal('12'), 1200);
  assert.equal(centsFromPayPal('0.1'), 10);
});
