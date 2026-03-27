import type { Model } from 'sequelize';
import type { Transaction as TransactionDto } from '@cashflow/shared';
import { num } from './numbers';

const numericKeys: (keyof TransactionDto)[] = [
  'amount',
  'autoPctMe',
  'pctMeOverride',
  'finalPctMe',
  'autoPctPartner',
  'pctPartnerOverride',
  'finalPctPartner',
  'myShareAmount',
  'partnerShareAmount',
  'businessAmount',
];

export function serializeTransaction(
  row: Model | Record<string, unknown>
): Record<string, unknown> {
  const o = 'toJSON' in row && typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  const out = o as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (k.includes('_')) delete out[k];
  }
  for (const k of numericKeys) {
    const key = k as string;
    if (out[key] !== undefined && out[key] !== null) {
      out[key] = num(out[key]);
    }
  }
  return out;
}
