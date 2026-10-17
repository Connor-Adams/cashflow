/**
 * CFO briefing builder (issue #236).
 *
 * Composes a deterministic action-item list from existing engines:
 *   - safeToSpend headline                       → computeSafeToSpend
 *   - forecast warnings (overdue planned events) → PlannedEvent query
 *   - new subscriptions in window                → Subscription query
 *   - rule suggestions                            → findRuleProposals
 *   - review backlog (unflagged review queue)    → Transaction count
 *   - import issues in window                    → ImportHistory query
 *   - anomalies (incl. missing receipts)         → Insight rows (real detectors)
 *
 * Everything is deterministic — no OpenAI required. That's the AC's
 * "AI summary is optional and gracefully disabled when unavailable"
 * requirement. The pure summary is exported so unit tests can verify
 * label/plural correctness without touching the DB.
 */

import { Op, literal } from 'sequelize';
import type { Request } from 'express';
import {
  Transaction,
  PlannedEvent,
  ImportHistory,
  Insight,
} from '../models';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { insightToActionItem, type InsightLike } from '../insights/toActionItems';
import { filterInsightsVisibleTo } from '../insights/visibility';
import { findRuleProposals } from '../ai/ruleProposals';
import { synthesizeBriefing } from './synthesizeBriefing';
import { getOpenAiConfig } from '../config/openai';
import {
  computeSafeToSpend,
  type SafeToSpendResult,
} from '../cashflow/safeToSpend';
import {
  loadOverduePlannedEvents,
  safeAbsNumber,
  buildOverdueEventItemContent,
  buildRuleSuggestionItemContent,
} from './reviewActionItemShared';
import type {
  CfoBriefingActionItem,
  CfoBriefingActionItemSeverity,
  CfoBriefingActionItemType,
  CfoBriefingSafeToSpendSnapshot,
} from '../models/CfoBriefing';

/** Persisted version of the briefing prompt/composition. Bump when the
 *  shape of action items materially changes so eval comparisons stay
 *  honest. */
export const CFO_BRIEFING_PROMPT_VERSION = 'cfo-briefing-v2';

/** Default window length when the caller omits explicit dates. */
const DEFAULT_BRIEFING_WINDOW_DAYS = 7;

/** Maximum window length — wider than this and it's no longer a
 *  "daily/weekly" briefing per the issue. */
export const MAX_BRIEFING_WINDOW_DAYS = 14;

/** Threshold below which safe-to-spend earns its own action item. Zero
 *  is the natural cutoff: negative means committed past available cash. */
const SAFE_TO_SPEND_LOW_THRESHOLD = 0;

/** Items above this review-backlog count get bumped to severity=action. */
const REVIEW_BACKLOG_ACTION_THRESHOLD = 25;

/** Items above this review-backlog count get severity=watch. Below: info. */
const REVIEW_BACKLOG_WATCH_THRESHOLD = 5;

/**
 * Compute the [periodStart, periodEnd] inclusive window for a briefing
 * given an as-of date. The window ends on `asOfDate` and goes back
 * `windowDays - 1` days (default 7-day = 6 days back).
 *
 * Exported because the route validation and the frontend tile need to
 * agree on what "default period" means without re-implementing the math.
 */
export function resolveDefaultBriefingPeriod(
  asOfDate: string,
  windowDays: number = DEFAULT_BRIEFING_WINDOW_DAYS,
): { periodStart: string; periodEnd: string } {
  const d = new Date(`${asOfDate}T00:00:00Z`);
  const start = new Date(d.getTime());
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return {
    periodStart: isoDate(start),
    periodEnd: asOfDate,
  };
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

export interface BriefingCounts {
  forecastWarnings: number;
  safeToSpendLow: number;
  newSubscriptions: number;
  ruleSuggestions: number;
  reviewBacklog: number;
  importIssues: number;
  anomalies: number;
}

/**
 * Pure formatter for the briefing's `summary` headline. Exported so
 * unit tests can assert label/plural without spinning up the DB.
 */
export function briefingShortSummary(counts: BriefingCounts): string {
  const total =
    counts.forecastWarnings +
    counts.safeToSpendLow +
    counts.newSubscriptions +
    counts.ruleSuggestions +
    counts.reviewBacklog +
    counts.importIssues +
    counts.anomalies;
  if (total === 0) return 'All clear — no action items for this briefing window.';
  const labels: string[] = [];
  push(labels, counts.forecastWarnings, 'forecast warning', 'forecast warnings');
  push(labels, counts.safeToSpendLow, 'safe-to-spend alert', 'safe-to-spend alerts');
  push(labels, counts.newSubscriptions, 'new subscription', 'new subscriptions');
  push(labels, counts.ruleSuggestions, 'rule suggestion', 'rule suggestions');
  push(labels, counts.reviewBacklog, 'review backlog item', 'review backlog items');
  push(labels, counts.importIssues, 'import issue', 'import issues');
  push(labels, counts.anomalies, 'anomaly', 'anomalies');
  return `${total} action item${total === 1 ? '' : 's'}: ${labels.join(', ')}.`;
}

function push(out: string[], n: number, singular: string, plural: string): void {
  if (n > 0) out.push(`${n} ${n === 1 ? singular : plural}`);
}

/**
 * Map an ImportHistory.status to a briefing action-item severity + title.
 * Pure so unit tests can lock the mapping without seeding rows.
 */
export function classifyImportIssue(status: string): {
  severity: CfoBriefingActionItemSeverity;
  title: string;
} {
  switch (status) {
    case 'failed':
      return { severity: 'action', title: 'Import failed' };
    case 'partial':
      return { severity: 'watch', title: 'Import partial — review needed' };
    case 'rolled_back':
      return { severity: 'watch', title: 'Import rolled back' };
    default:
      return { severity: 'info', title: `Import status: ${status}` };
  }
}

export interface BuildBriefingParams {
  req: Request;
  householdId: number;
  userId: number;
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** Test seam — defaults to the real synthesis pass. */
  synthesizeImpl?: typeof synthesizeBriefing;
}

export interface BuildBriefingResult {
  actionItems: CfoBriefingActionItem[];
  summary: string;
  safeToSpendSnapshot: CfoBriefingSafeToSpendSnapshot | null;
  /**
   * Provenance for the persisted row: the OpenAI model id when the synthesis
   * pass actually wrote the summary, `'deterministic'` when we fell back to
   * `briefingShortSummary`. Derived from the same condition as the summary
   * itself so the two can never drift.
   */
  model: string;
}

/** Provenance label for a briefing whose summary came from the counters. */
export const DETERMINISTIC_BRIEFING_MODEL = 'deterministic';

function idFor(type: CfoBriefingActionItemType, suffix: string | number): string {
  return `${type}-${suffix}`;
}

function reviewBacklogSeverity(count: number): CfoBriefingActionItemSeverity {
  if (count >= REVIEW_BACKLOG_ACTION_THRESHOLD) return 'action';
  if (count >= REVIEW_BACKLOG_WATCH_THRESHOLD) return 'watch';
  return 'info';
}

function snapshotFromSafeToSpend(
  result: SafeToSpendResult,
): CfoBriefingSafeToSpendSnapshot {
  return {
    value: result.value,
    currency: result.currency,
    isNegative: result.isNegative,
    windowDays: result.windowDays,
    windowEndDate: result.windowEndDate,
    asOfDate: result.asOfDate,
  };
}

/**
 * Most open insights a single briefing will carry. Open insights accumulate
 * without bound (production sits at ~140 open `missing_receipt` rows alone),
 * and every one of them is persisted into `CfoBriefing.actionItems` AND
 * serialized into the synthesis prompt — so an uncapped read makes token
 * cost, latency and JSON-truncation risk scale with the table.
 *
 * Deliberately NOT filtered by the briefing window: insights are standing
 * observations, not period events, so a stale-but-open critical insight must
 * still surface. The cap is severity-first instead, so what gets dropped is
 * always the least severe / oldest tail.
 */
export const MAX_OPEN_INSIGHT_ITEMS = 20;

/** Severity rank for ordering: critical first, then warning, then everything
 *  else. A CASE expression rather than an ORDER BY on the raw column because
 *  the stored values sort alphabetically ('critical' < 'info' < 'warning'),
 *  which is not the severity order. Standard SQL — runs on SQLite and
 *  Postgres alike. */
const INSIGHT_SEVERITY_RANK_SQL =
  "CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END";

/**
 * Open insights for the household, as briefing action items — the most severe
 * `MAX_OPEN_INSIGHT_ITEMS` *that the requesting user may see*, newest first
 * within a severity. Exported so the unit test can exercise the query without
 * building a whole briefing.
 *
 * `req` is what scopes the read: `Insight` rows are household-wide (detectors
 * run with no viewer), so an insight derived from the other partner's private
 * transaction must be dropped here — see `filterInsightsVisibleTo`.
 */
export async function loadOpenInsightItems(
  req: Request,
  householdId: number,
): Promise<CfoBriefingActionItem[]> {
  const rows = await Insight.findAll({
    where: { householdId, status: 'open' },
    attributes: [
      'id',
      'type',
      'severity',
      'title',
      'description',
      'entityType',
      'entityId',
      'metadata',
    ],
    order: [
      [literal(INSIGHT_SEVERITY_RANK_SQL), 'ASC'],
      ['detectedAt', 'DESC'],
    ],
    // No SQL `limit`: the cap has to be applied AFTER the visibility filter.
    // Capping first would let a row the viewer cannot see occupy one of the
    // `MAX_OPEN_INSIGHT_ITEMS` slots and silently push out an insight they
    // could have acted on. Ordering still happens in SQL, so the post-filter
    // slice keeps the same severest-then-newest semantics.
  });
  // Not `raw: true`: SQLite stores the `metadata` JSON column as TEXT, and a
  // raw query returns that column un-parsed (a string), which breaks
  // `supportingIdsFromMetadata`'s object check. Going through model
  // instances runs Sequelize's JSON getter so `metadata` comes back as a
  // real object on both dialects.
  const visible = await filterInsightsVisibleTo(req, rows);
  return visible
    .slice(0, MAX_OPEN_INSIGHT_ITEMS)
    .map((row) => insightToActionItem(row.toJSON() as unknown as InsightLike));
}

/**
 * Main entry point — returns the full action-item list + summary + safe-to-spend
 * snapshot for a household + window. Deterministic; OpenAI not invoked.
 *
 * Each sub-source is wrapped in a try/catch so a failure in one sub-source
 * (e.g. computeSafeToSpend missing a setting row) doesn't kill the whole
 * briefing. Failures get logged via the returned summary but don't throw.
 */
export async function buildCfoBriefing(
  params: BuildBriefingParams,
): Promise<BuildBriefingResult> {
  const { req, householdId, userId, periodStart, periodEnd, currency } = params;

  const [
    safeToSpend,
    insightsOut,
    ruleProposals,
    plannedEventsOverdue,
    newSubscriptions,
    reviewBacklogCount,
    importIssues,
  ] = await Promise.all([
    safeBriefingFetch(() =>
      computeSafeToSpend({
        userId,
        householdId,
        currency,
        asOfDate: periodEnd,
      }),
    ),
    safeBriefingFetch(() => loadOpenInsightItems(req, householdId)),
    safeBriefingFetch(() => findRuleProposals(householdId)),
    loadOverduePlannedEvents(householdId, periodEnd),
    PlannedEvent.findAll({
      where: {
        ...householdWhere(req),
        kind: 'subscription',
        status: 'planned',
        statusUncertain: false,
        createdAt: { [Op.between]: [`${periodStart}T00:00:00Z`, `${periodEnd}T23:59:59Z`] },
      },
      attributes: ['id', 'name', 'amount', 'currency', 'cadence'],
      raw: true,
    }),
    Transaction.count({
      where: {
        ...visibleTransactionWhere(req),
        reviewFlag: true,
      },
    }),
    ImportHistory.findAll({
      where: {
        ...householdWhere(req),
        status: { [Op.in]: ['failed', 'partial', 'rolled_back'] },
        createdAt: { [Op.between]: [`${periodStart}T00:00:00Z`, `${periodEnd}T23:59:59Z`] },
      },
      attributes: ['id', 'fileName', 'status', 'errorMessage', 'createdAt'],
      raw: true,
    }),
  ]);

  const items: CfoBriefingActionItem[] = [];

  // 1. Safe-to-spend headline (also stored as snapshot).
  let safeToSpendSnapshot: CfoBriefingSafeToSpendSnapshot | null = null;
  if (safeToSpend) {
    safeToSpendSnapshot = snapshotFromSafeToSpend(safeToSpend);
    if (safeToSpend.value < SAFE_TO_SPEND_LOW_THRESHOLD) {
      items.push({
        id: idFor('safe_to_spend_low', 'headline'),
        type: 'safe_to_spend_low',
        refType: null,
        refId: null,
        severity: 'action',
        title: 'Safe to spend is negative',
        summary: `Safe-to-spend is ${safeToSpend.value.toFixed(2)} ${safeToSpend.currency} for the ${safeToSpend.windowDays}-day window through ${safeToSpend.windowEndDate}.`,
        status: 'open',
        rationale: 'Current cash minus upcoming obligations minus minimum buffer is below zero.',
        link: '/forecast',
      });
    }
  }

  // 2. Anomalies from the insight detectors.
  if (insightsOut) {
    items.push(...insightsOut);
  }

  // 3. Rule suggestions.
  if (ruleProposals) {
    for (const proposal of ruleProposals) {
      const content = buildRuleSuggestionItemContent(
        proposal,
        `Suggested rule: "${proposal.merchantPattern}"`,
      );
      items.push({
        ...content,
        type: 'rule_suggestion',
        status: 'open',
        link: '/rules',
      });
    }
  }

  // 4. New subscriptions detected in the window. The merged PlannedEvent stores
  // the merchant in `name` (kind='subscription'); the legacy column was
  // `merchantName`.
  type SubRow = {
    id: number;
    name: string;
    amount: unknown;
    currency: string;
    cadence: string;
  };
  for (const raw of newSubscriptions as unknown as SubRow[]) {
    const monthly = safeAbsNumber(raw.amount);
    items.push({
      id: idFor('new_subscription', raw.id),
      type: 'new_subscription',
      refType: 'subscription',
      refId: raw.id,
      severity: 'info',
      title: `New subscription: ${raw.name}`,
      summary: `${raw.name} (${monthly.toFixed(2)} ${raw.currency} ${raw.cadence}) detected since the start of this briefing window.`,
      status: 'open',
      rationale: 'Subscription was created or first observed in this briefing window.',
      link: '/subscriptions',
    });
  }

  // 5. Forecast warnings: planned events overdue.
  for (const raw of plannedEventsOverdue) {
    const content = buildOverdueEventItemContent(raw, currency);
    items.push({
      ...content,
      type: 'forecast_warning',
      status: 'open',
      link: '/planned',
    });
  }

  // 6. Review backlog — if there are flagged transactions, surface one
  // aggregated item with the count (frontend links into the queue).
  if (reviewBacklogCount > 0) {
    items.push({
      id: idFor('review_backlog', 'count'),
      type: 'review_backlog',
      refType: null,
      refId: null,
      severity: reviewBacklogSeverity(reviewBacklogCount),
      title: `${reviewBacklogCount} transaction${reviewBacklogCount === 1 ? '' : 's'} need review`,
      summary: `Your review inbox has ${reviewBacklogCount} flagged item${reviewBacklogCount === 1 ? '' : 's'} waiting on a decision.`,
      status: 'open',
      rationale: 'Transactions marked review_flag=true are unresolved.',
      link: '/review',
    });
  }

  // 7. Import issues during the window.
  type ImportRow = {
    id: number;
    fileName: string;
    status: string;
    errorMessage: string | null;
  };
  for (const raw of importIssues as unknown as ImportRow[]) {
    const c = classifyImportIssue(raw.status);
    items.push({
      id: idFor('import_issue', raw.id),
      type: 'import_issue',
      refType: 'import',
      refId: raw.id,
      severity: c.severity,
      title: `${c.title}: ${raw.fileName}`,
      summary: raw.errorMessage
        ? `${raw.fileName}: ${raw.errorMessage}`
        : `${raw.fileName} (status: ${raw.status})`,
      status: 'open',
      rationale: `ImportHistory row ${raw.id} is in non-success state '${raw.status}'.`,
      link: `/import/${raw.id}`,
    });
  }

  const counts: BriefingCounts = {
    forecastWarnings: 0,
    safeToSpendLow: 0,
    newSubscriptions: 0,
    ruleSuggestions: 0,
    reviewBacklog: 0,
    importIssues: 0,
    anomalies: 0,
  };
  for (const item of items) {
    switch (item.type) {
      case 'forecast_warning':
        counts.forecastWarnings += 1;
        break;
      case 'safe_to_spend_low':
        counts.safeToSpendLow += 1;
        break;
      case 'missing_receipt':
        // No longer produced here — detectMissingReceipt now emits this as
        // an Insight, mapped to type 'anomaly' below. Kept as a case so a
        // historical briefing loaded from storage (pre-migration) still
        // switches exhaustively instead of falling through silently.
        break;
      case 'new_subscription':
        counts.newSubscriptions += 1;
        break;
      case 'rule_suggestion':
        counts.ruleSuggestions += 1;
        break;
      case 'review_backlog':
        counts.reviewBacklog += 1;
        break;
      case 'import_issue':
        counts.importIssues += 1;
        break;
      case 'anomaly':
        counts.anomalies += 1;
        break;
    }
  }

  const fallbackSummary = briefingShortSummary(counts);
  const synthesize = params.synthesizeImpl ?? synthesizeBriefing;
  const synthesis = await synthesize({
    items,
    safeToSpend: safeToSpendSnapshot,
    currency,
  });

  return {
    actionItems: synthesis.ordered,
    summary: synthesis.summary ?? fallbackSummary,
    safeToSpendSnapshot,
    model:
      synthesis.summary == null
        ? DETERMINISTIC_BRIEFING_MODEL
        : (getOpenAiConfig()?.model ?? 'llm'),
  };
}

/**
 * Run a sub-source builder, returning null if it throws. Each sub-source
 * is independent — we don't want a bad merchant memory row to kill the
 * whole briefing. The route layer logs failures via the run's status.
 */
async function safeBriefingFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
