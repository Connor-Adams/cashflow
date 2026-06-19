/**
 * Confidence tiering for the discovery pass. Pure — no DB, no network.
 *
 * HIGH (auto-ingest): a deterministic vendor parser matched (we trust those
 * regardless of sender), OR Gmail itself filed the mail under purchases AND we
 * got a clean structured extract AND its amount matches a real transaction.
 * Everything else is LOW (surface the sender as a suggestion, write no order).
 */
export function isPurchasesLabel(labelIds: string[] | null | undefined): boolean {
  return Array.isArray(labelIds) && labelIds.includes('CATEGORY_PURCHASES');
}

export function classifyDiscoveryConfidence(args: {
  parser: string;
  isPurchases: boolean;
  hasCleanExtract: boolean;
  amountMatched: boolean;
}): 'high' | 'low' {
  if (args.parser !== 'ai') return 'high';
  if (args.isPurchases && args.hasCleanExtract && args.amountMatched) return 'high';
  return 'low';
}
