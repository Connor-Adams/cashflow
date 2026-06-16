// Shared Costco product-resolution contracts and pure helpers.
//
// Extracted here to break a circular dependency: resolveCostcoProducts.ts
// imports makeGoogleBestEffortResolver from integrations/costco/googleImageCaller.ts,
// and googleImageCaller.ts needs the resolver types + the itemNumbersMatch helper.
// Hosting those shared pieces in this leaf module (no further intra-package imports)
// lets both files depend on it instead of on each other.
import type { CostcoProductStatus } from '../../models/CostcoProduct';

/** The cache-row fields produced by resolving one item number. */
export type ResolvedProduct = {
  itemNumber: string;
  status: CostcoProductStatus;
  imageUrl: string | null;
  costcoUrl: string | null;
  officialName: string | null;
  onlinePrice: string | null;
  source: string;
  verified: boolean;
};

export type ItemNumberToResolve = { itemNumber: string; name: string };

export type PerItemResolver = (itemNumber: string, name: string) => Promise<ResolvedProduct>;

/** Digits-only equality; tolerates leading zeros and surrounding text. Null/empty never match. */
export function itemNumbersMatch(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  const da = a.replace(/\D/g, '').replace(/^0+/, '');
  const db = b.replace(/\D/g, '').replace(/^0+/, '');
  if (da === '' || db === '') return false;
  return da === db;
}
