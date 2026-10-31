import type { Cents } from './money.ts';

export interface DebtorHistory {
  invoicesDue: number;
  paidOnTime: number;
  daysLateAverage: number;
  outstandingCents: Cents;
  limitCents: Cents;
  monthsActive: number;
  disputes: number;
  totalInvoices: number;
  faceCents: Cents;
}

export interface ScoreComponents {
  onTime: { points: number; max: number; detail: string };
  daysLate: { points: number; max: number; detail: string };
  exposure: { points: number; max: number; detail: string };
  relationship: { points: number; max: number; detail: string };
  disputes: { points: number; max: number; detail: string };
  size: { points: number; max: number; detail: string };
}

export type Band = 'A' | 'B' | 'C' | 'D';

export interface ScoreResult {
  score: number;
  band: Band;
  components: ScoreComponents;
  /**
   * Set when the band is not the one the score alone would earn — today that means one thing: a sale
   * with no PayPal transaction behind it loses the rail signal, so the desk will not hold a band-A
   * position on paperwork only.
   */
  bandNote?: string;
}

const BAND_TERMS: Record<Band, { premiumBp: number; maxAdvanceBp: number; tenorCapDays: number }> = {
  A: { premiumBp: 0, maxAdvanceBp: 9000, tenorCapDays: 90 },
  B: { premiumBp: 600, maxAdvanceBp: 8000, tenorCapDays: 90 },
  C: { premiumBp: 1500, maxAdvanceBp: 6000, tenorCapDays: 60 },
  D: { premiumBp: 0, maxAdvanceBp: 0, tenorCapDays: 0 }
};

export function bandTerms(band: Band) {
  return BAND_TERMS[band];
}

export function scoreDebtor(h: DebtorHistory, options: { railCorroborated?: boolean } = {}): ScoreResult {
  const railCorroborated = options.railCorroborated !== false;
  const invoicesDue = Math.max(h.invoicesDue, 0);
  const totalInvoices = Math.max(h.totalInvoices, invoicesDue);
  const limit = Math.max(h.limitCents, 1);

  const onTimeRate = invoicesDue === 0 ? 0 : h.paidOnTime / invoicesDue;
  const onTime = Math.round(40 * onTimeRate);

  const lateFraction = Math.min(Math.max(h.daysLateAverage, 0) / 30, 1);
  const daysLate = Math.round(15 * (1 - lateFraction));

  const exposureFraction = Math.min(Math.max(h.outstandingCents / limit, 0), 1);
  const exposure = Math.round(15 * (1 - exposureFraction));

  const relationship = Math.round(Math.min(Math.max(h.monthsActive, 0) / 24, 1) * 10);

  const disputeRate = totalInvoices === 0 ? 0 : h.disputes / totalInvoices;
  const disputes = Math.round(10 * (1 - Math.min(disputeRate, 1)));

  const sizeFraction = Math.min(Math.max(h.faceCents / limit, 0), 1);
  const size = Math.round(10 * (1 - sizeFraction));

  const score = onTime + daysLate + exposure + relationship + disputes + size;
  let band: Band = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  let bandNote: string | undefined;

  // A band-A position is the one the desk is least willing to hold on paperwork alone: no advance
  // above 90% of face, and that ceiling exists because the rail vouched for the sale. Take the vouch
  // away and the largest, cheapest advance has to go with it.
  if (!railCorroborated && band === 'A') {
    band = 'B';
    bandNote = 'Uncorroborated sale: E00 found no PayPal transaction behind this invoice, so the band is held at B whatever the score earns.';
  }

  return {
    score,
    band,
    ...(bandNote ? { bandNote } : {}),
    components: {
      onTime: { points: onTime, max: 40, detail: `${h.paidOnTime} of ${invoicesDue} invoices paid on time` },
      daysLate: { points: daysLate, max: 15, detail: `${h.daysLateAverage.toFixed(1)} days late on average` },
      exposure: { points: exposure, max: 15, detail: `outstanding exposure within the ${(limit / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} limit` },
      relationship: { points: relationship, max: 10, detail: `${h.monthsActive} months of history on this platform` },
      disputes: { points: disputes, max: 10, detail: `${h.disputes} disputes across ${totalInvoices} invoices` },
      size: { points: size, max: 10, detail: `invoice size against the credit limit` }
    }
  };
}
