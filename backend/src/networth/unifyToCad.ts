import { ensureFxRate } from '../fx/bankOfCanada';
import { toUnits, fromUnits } from '../util/numbers';

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
  let totalAssetsU = 0;
  let totalLiabilitiesU = 0;
  const fxRatesUsed: FxRateUsed[] = [];
  const gaps: UnifyGap[] = [];

  for (const [currency, { asset, liability }] of Object.entries(perCurrency)) {
    if (currency === 'CAD') {
      totalAssetsU += toUnits(asset);
      totalLiabilitiesU += toUnits(liability);
      continue;
    }
    const fx = await fxLookup(currency, 'CAD', asOf);
    if (!fx) {
      gaps.push({ date: asOf, currency, reason: 'fx_rate_unavailable' });
      continue;
    }
    totalAssetsU += toUnits(asset * fx.rate);
    totalLiabilitiesU += toUnits(liability * fx.rate);
    fxRatesUsed.push({ from: currency, to: 'CAD', rate: fx.rate, ratedDate: fx.ratedDate });
  }

  return { totalAssets: fromUnits(totalAssetsU), totalLiabilities: fromUnits(totalLiabilitiesU), fxRatesUsed, gaps };
}
