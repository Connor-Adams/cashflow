/**
 * Maps persisted `Insight` rows onto `CfoBriefingActionItem`s.
 *
 * The CFO briefing and the AI review both used to build their "anomaly" items
 * from a second, now-deleted insight engine that emitted six fixed templates
 * and never saw the real detectors. Both now read `Insight` rows,
 * and this module owns the single mapping between the two shapes.
 *
 * Note the two severity vocabularies: `Insight.severity` is
 * info|warning|critical, `CfoBriefingActionItemSeverity` is info|watch|action.
 */
import type {
  CfoBriefingActionItem,
  CfoBriefingActionItemRefType,
  CfoBriefingActionItemSeverity,
} from '../models/CfoBriefing';
import type { InsightSeverity } from '../models/Insight';

export type InsightLike = {
  id: number;
  type: string;
  severity: InsightSeverity;
  title: string;
  description: string | null;
  entityType: string | null;
  entityId: number | null;
  metadata: unknown;
};

export function mapInsightSeverity(s: InsightSeverity): CfoBriefingActionItemSeverity {
  if (s === 'critical') return 'action';
  if (s === 'warning') return 'watch';
  return 'info';
}

/**
 * Several detectors put the transactions behind a finding in
 * `metadata.transactionIds` (see detectDuplicateTransactions). Anything else
 * yields an empty list rather than a partial one.
 */
export function supportingIdsFromMetadata(metadata: unknown): number[] {
  if (metadata == null || typeof metadata !== 'object') return [];
  const raw = (metadata as { transactionIds?: unknown }).transactionIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** `CfoBriefingActionItemRefType` is a closed union; anything else is dropped. */
const REF_TYPES = new Set(['transaction', 'event', 'rule', 'subscription', 'import']);

function refTypeFrom(entityType: string | null): CfoBriefingActionItemRefType {
  return entityType && REF_TYPES.has(entityType)
    ? (entityType as CfoBriefingActionItemRefType)
    : null;
}

export function insightToActionItem(row: InsightLike): CfoBriefingActionItem {
  const refType = refTypeFrom(row.entityType);
  return {
    id: `insight-${row.id}`,
    type: 'anomaly',
    refType,
    refId: refType == null ? null : row.entityId,
    severity: mapInsightSeverity(row.severity),
    title: row.title,
    summary: row.description ?? row.title,
    status: 'open',
    supportingTransactionIds: supportingIdsFromMetadata(row.metadata),
    rationale: `Detected by the ${row.type} insight detector.`,
    link: '/insights',
  };
}
