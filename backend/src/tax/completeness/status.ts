import type { CompletenessItem, CompletenessStatus } from './types';

/** Worst-wins: any blocker blocks, any gap downgrades, otherwise complete. */
export function worstStatus(items: readonly CompletenessItem[]): CompletenessStatus {
  if (items.some((i) => i.severity === 'blocker')) return 'blocked';
  if (items.length > 0) return 'gaps';
  return 'complete';
}
