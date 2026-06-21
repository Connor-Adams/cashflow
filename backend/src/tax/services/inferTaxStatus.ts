import type { AccountTaxStatus } from '../../models/Account';

/**
 * Infer the `tax_status` of an INVESTMENT account from its name.
 *
 * `buildPersonalFacts` only keeps in-account investment income/gains off the
 * personal T1 for accounts whose `tax_status` is NOT in the taxable allowlist
 * (`'non_registered'`, `'n_a'`). A registered account left at the historical
 * `'n_a'` default therefore leaks its sheltered earnings onto the return. This
 * maps the registered account types from their (reliable) names; anything
 * unrecognised is treated as `non_registered` (taxable).
 *
 * Keyword checks are priority-ordered and assume a name carries at most one
 * registered keyword (true for every real brokerage account name). Intended for
 * `account_type === 'investment'`; non-investment accounts are left at their
 * `'n_a'` default by callers.
 */
export function inferTaxStatus(name: string): AccountTaxStatus {
  const n = name.toLowerCase();
  if (n.includes('tfsa')) return 'registered_tfsa';
  if (n.includes('fhsa')) return 'registered_fhsa';
  if (n.includes('rrsp')) return 'registered_rrsp';
  if (n.includes('rrif')) return 'registered_rrif';
  if (n.includes('rdsp')) return 'registered_rdsp';
  if (n.includes('resp')) return 'registered_resp';
  return 'non_registered';
}
