import { ensureFxRate } from '../fx/bankOfCanada';

export type FxLookup = (
  from: string,
  to: string,
  asOf: string
) => Promise<{ rate: number; ratedDate: string } | null>;

export type PerCurrencyByKind = Record<string, { asset: number; liability: number }>;

export type FxRateUsed = {
  from: string;
  to: 'CAD';
  rate: number;
  ratedDate: string;
};

export type UnifyGap = {
  date: string;
  currency: string;
  reason: 'fx_rate_unavailable';
};

export type UnifyResult = {
  totalAssets: number;
  totalLiabilities: number;
  fxRatesUsed: FxRateUsed[];
  gaps: UnifyGap[];
};

const defaultFxLookup: FxLookup = (from, to, asOf) => ensureFxRate(from, to, asOf);

export async function unifyToCad(
  perCurrency: PerCurrencyByKind,
  asOf: string,
  fxLookup: FxLookup = defaultFxLookup
): Promise<UnifyResult> {
  let totalAssets = 0;
  let totalLiabilities = 0;
  const fxRatesUsed: FxRateUsed[] = [];
  const gaps: UnifyGap[] = [];

  for (const [currency, { asset, liability }] of Object.entries(perCurrency)) {
    if (currency === 'CAD') {
      totalAssets += asset;
      totalLiabilities += liability;
      continue;
    }
    const fx = await fxLookup(currency, 'CAD', asOf);
    if (!fx) {
      gaps.push({ date: asOf, currency, reason: 'fx_rate_unavailable' });
      continue;
    }
    totalAssets += asset * fx.rate;
    totalLiabilities += liability * fx.rate;
    fxRatesUsed.push({ from: currency, to: 'CAD', rate: fx.rate, ratedDate: fx.ratedDate });
  }

  return { totalAssets, totalLiabilities, fxRatesUsed, gaps };
}
