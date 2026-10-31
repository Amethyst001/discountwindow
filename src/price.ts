import { mulRate, type Cents } from './money.ts';
import { bandTerms, type Band } from './score.ts';

export const BASE_RATE_BP = 800;
const FEE_PERCENT_BP = 290; // 2.9%
const FEE_FIXED_CENTS = 30;
const PLATFORM_FEE_BP = 50; // 0.5% of face, charged to the seller

/** What PayPal withholds from a payee on a capture, on the published US schedule. */
export function paypalFeeOn(cents: Cents): Cents {
  return Math.round((cents * FEE_PERCENT_BP) / 10_000) + FEE_FIXED_CENTS;
}

export interface SettlementSplit {
  faceCents: Cents;
  grossFunderCents: Cents;
  grossSellerCents: Cents;
  feeFunderCents: Cents;
  feeSellerCents: Cents;
  feeCents: Cents;
  funderNetCents: Cents;
  sellerNetCents: Cents;
  funderYieldCents: Cents;
}

/**
 * At maturity the debtor pays face. The funder's purchase unit is its gross slice (advance +
 * discount + the fee reserve priced into it); the seller keeps the remainder. PayPal withholds a
 * receiving fee from every payee and these sandbox captures do not return the amount, so the fee
 * is booked from the same schedule the desk prices against and labelled an estimate on the receipt.
 */
export function settlementSplit(
  faceCents: Cents,
  price: { advance_cents: number; discount_cents: number; fee_reserve_cents: number }
): SettlementSplit {
  const grossFunderCents = Number(price.advance_cents) + Number(price.discount_cents) + Number(price.fee_reserve_cents);
  const grossSellerCents = faceCents - grossFunderCents;
  if (grossFunderCents <= 0 || grossSellerCents < 0) throw new Error('the slice does not fit inside the face value');
  const feeFunderCents = Math.min(paypalFeeOn(grossFunderCents), grossFunderCents);
  const feeSellerCents = grossSellerCents > 0 ? Math.min(paypalFeeOn(grossSellerCents), grossSellerCents) : 0;
  const funderNetCents = grossFunderCents - feeFunderCents;
  const sellerNetCents = grossSellerCents - feeSellerCents;
  return {
    faceCents,
    grossFunderCents,
    grossSellerCents,
    feeFunderCents,
    feeSellerCents,
    feeCents: feeFunderCents + feeSellerCents,
    funderNetCents,
    sellerNetCents,
    funderYieldCents: funderNetCents - Number(price.advance_cents)
  };
}

export interface PriceInput {
  faceCents: Cents;
  shareBp: number;
  tenorDays: number;
  band: Band;
  /**
   * Who stands behind the paper if the debtor never pays. `recourse` is the desk's default: the
   * seller repurchases the receivable, so the funder's outlay comes back from the seller rather than
   * from the debtor's credit. `non_recourse` puts that risk on the desk's own underwriting of the
   * debtor, and is charged for it — and is not available in band C, where the record is the reason
   * the seller is being asked to stand behind the sale in the first place.
   */
  recourse?: RecourseTerm;
}

export type RecourseTerm = 'recourse' | 'non_recourse';

export const NON_RECOURSE_PREMIUM_BP = 400;

export interface PriceResult {
  ok: boolean;
  reason?: string;
  annualRateBp: number;
  grossSliceCents: Cents;
  feeReserveCents: Cents;
  netSliceCents: Cents;
  discountCents: Cents;
  advanceCents: Cents;
  platformFeeCents: Cents;
  recourse: RecourseTerm;
}

export function priceSlice(input: PriceInput): PriceResult {
  const terms = bandTerms(input.band);
  const platformFeeCents = Math.round((input.faceCents * PLATFORM_FEE_BP) / 10_000);
  const recourse: RecourseTerm = input.recourse ?? 'recourse';

  if (input.band === 'D') {
    return {
      ok: false,
      reason: 'A debtor in band D is not financeable at any price on this desk.',
      annualRateBp: 0, grossSliceCents: 0, feeReserveCents: 0, netSliceCents: 0,
      discountCents: 0, advanceCents: 0, platformFeeCents, recourse
    };
  }
  if (input.shareBp > terms.maxAdvanceBp) {
    return {
      ok: false,
      reason: `Band ${input.band} funds at most ${(terms.maxAdvanceBp / 100).toFixed(0)}% of face; ${(input.shareBp / 100).toFixed(0)}% was requested.`,
      annualRateBp: 0, grossSliceCents: 0, feeReserveCents: 0, netSliceCents: 0,
      discountCents: 0, advanceCents: 0, platformFeeCents, recourse
    };
  }
  if (input.tenorDays > terms.tenorCapDays) {
    return {
      ok: false,
      reason: `Band ${input.band} caps tenor at ${terms.tenorCapDays} days; this invoice runs ${input.tenorDays}.`,
      annualRateBp: 0, grossSliceCents: 0, feeReserveCents: 0, netSliceCents: 0,
      discountCents: 0, advanceCents: 0, platformFeeCents, recourse
    };
  }
  if (recourse === 'non_recourse' && input.band === 'C') {
    return {
      ok: false,
      reason: 'Band C paper is bought with recourse to the seller: the record is too thin for the desk to take the debtor\'s credit risk in its own name at any rate.',
      annualRateBp: 0, grossSliceCents: 0, feeReserveCents: 0, netSliceCents: 0,
      discountCents: 0, advanceCents: 0, platformFeeCents, recourse: 'recourse'
    };
  }

  const annualRateBp = BASE_RATE_BP + terms.premiumBp + (recourse === 'non_recourse' ? NON_RECOURSE_PREMIUM_BP : 0);
  const grossSliceCents = mulRate(input.faceCents, input.shareBp, 10_000);
  const feeReserveCents = Math.round((grossSliceCents * FEE_PERCENT_BP) / 10_000) + FEE_FIXED_CENTS;
  const netSliceCents = grossSliceCents - feeReserveCents;
  const discountCents = mulRate(netSliceCents, annualRateBp * input.tenorDays, 10_000 * 365);
  const advanceCents = netSliceCents - discountCents;

  return {
    ok: true,
    annualRateBp,
    grossSliceCents,
    feeReserveCents,
    netSliceCents,
    discountCents,
    advanceCents,
    platformFeeCents,
    recourse
  };
}
