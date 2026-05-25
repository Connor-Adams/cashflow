/**
 * Pure tax-classification helpers for the by-account-type view.
 *
 * Used by the /api/portfolio/by-account-type route handler to derive
 * per-row flags, identify tax-loss-harvest candidates, and label
 * buckets.
 */
import type { AccountTaxStatus } from '../models/Account';

export const TAX_STATUS_LABELS: Record<AccountTaxStatus, string> = {
  registered_tfsa: 'TFSA',
  registered_rrsp: 'RRSP',
  registered_fhsa: 'FHSA',
  registered_rrif: 'RRIF',
  non_registered: 'Non-registered',
  n_a: 'Other',
};

// Display order for bucket cards.
export const TAX_STATUS_ORDER: AccountTaxStatus[] = [
  'registered_tfsa',
  'registered_rrsp',
  'registered_fhsa',
  'registered_rrif',
  'non_registered',
  'n_a',
];

export const TAX_LOSS_THRESHOLD_CAD = 500;

const CANADIAN_SUFFIXES = ['.TO', '.NEO', '.CSE', '.V', '.TRT'];
const UK_SUFFIXES = ['.L', '.LON'];

export type SecurityForClassification = {
  symbol: string
  currency: string
  metadata: Record<string, unknown> | null
};

export function isUsDomiciled(security: SecurityForClassification): boolean {
  const country = (security.metadata?.['country'] as string | undefined)?.toLowerCase();
  if (country) {
    return country === 'usa' || country === 'united states' || country === 'us';
  }
  const sym = security.symbol.toUpperCase();
  if (CANADIAN_SUFFIXES.some((s) => sym.endsWith(s))) return false;
  if (UK_SUFFIXES.some((s) => sym.endsWith(s))) return false;
  if (sym.includes('.')) return false;
  return security.currency === 'USD';
}

export function isFixedIncome(assetType: string | null): boolean {
  if (!assetType) return false;
  return /bond|gic|fixed|treasury|note|debent/i.test(assetType);
}

export type RowFlag = 'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa';

export type RowFlagsInput = {
  security: SecurityForClassification & { assetType: string | null }
  account: { taxStatus: AccountTaxStatus }
  hasDividends: boolean
};

export function rowFlags(input: RowFlagsInput): RowFlag[] {
  const flags: RowFlag[] = [];
  const us = isUsDomiciled(input.security);
  if (us && input.account.taxStatus === 'non_registered') flags.push('us_withholding');
  if (isFixedIncome(input.security.assetType) && input.account.taxStatus === 'non_registered') {
    flags.push('fixed_income_in_non_reg');
  }
  if (us && input.hasDividends && input.account.taxStatus === 'registered_tfsa') {
    flags.push('us_payer_in_tfsa');
  }
  return flags;
}

export type HarvestInput = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  costBasisCad: number | null
  marketValueCad: number | null
};

export function harvestCandidate(input: HarvestInput): { unrealizedLossCad: number } | null {
  if (input.costBasisCad == null || input.marketValueCad == null) return null;
  const loss = input.costBasisCad - input.marketValueCad;
  if (loss <= TAX_LOSS_THRESHOLD_CAD) return null;
  return { unrealizedLossCad: loss };
}
