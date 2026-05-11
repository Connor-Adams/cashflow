import { num } from '../util/numbers';
import type { AiSuggestion } from './suggestTransaction';

export type TransactionFinalSnapshot = {
  category: string | null;
  business: boolean | null;
  splitType: string | null;
  pctMe: number | null;
  pctPartner: number | null;
  notes: string | null;
};

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function sameNumber(a: unknown, b: unknown): boolean {
  const na = num(a);
  const nb = num(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) <= 0.0001;
}

export function scoreTransactionSuggestion(
  suggestion: AiSuggestion,
  finalSnapshot: TransactionFinalSnapshot,
): {
  status: 'accepted' | 'edited';
  metrics: Record<string, boolean>;
} {
  const metrics = {
    categoryMatch:
      nullableString(suggestion.category) === nullableString(finalSnapshot.category),
    businessMatch: suggestion.business === finalSnapshot.business,
    splitTypeMatch: suggestion.splitType === finalSnapshot.splitType,
    pctMeMatch: sameNumber(suggestion.pctMe, finalSnapshot.pctMe),
    pctPartnerMatch: sameNumber(suggestion.pctPartner, finalSnapshot.pctPartner),
  };
  return {
    status: Object.values(metrics).every(Boolean) ? 'accepted' : 'edited',
    metrics,
  };
}
