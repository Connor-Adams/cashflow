/**
 * Pure auto-accept decision shared by the Amazon order matcher and the
 * vendor-generic receipt matcher. No imports — safe for either side to depend
 * on without creating a module cycle.
 */
export const AUTO_ACCEPT_THRESHOLD = 85; // exact-amount match baseline is 90 (50 amount + 25 date + 15 vendor)
export const AUTO_ACCEPT_MARGIN = 10; // best must lead runner-up by MORE than this to be unambiguous

/**
 * Decide whether the top-scored candidate is safe to auto-accept: high enough
 * confidence AND unambiguous (sole qualifier, or a clear margin over the
 * runner-up). `sortedConfidences` is sorted descending.
 */
export function decideAutoAccept(sortedConfidences: number[]): boolean {
  if (sortedConfidences.length === 0) return false;
  if (sortedConfidences[0] < AUTO_ACCEPT_THRESHOLD) return false;
  if (sortedConfidences.length === 1) return true;
  return sortedConfidences[0] - sortedConfidences[1] > AUTO_ACCEPT_MARGIN;
}
