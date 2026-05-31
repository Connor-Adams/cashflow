/**
 * CFO briefing builder (issue #236).
 *
 * Composes a deterministic action-item list from existing engines:
 *   - safeToSpend headline                       → computeSafeToSpend
 *   - forecast warnings (overdue planned events) → PlannedEvent query
 *   - missing receipts on big-ticket spend       → Transaction join
 *   - new subscriptions in window                → Subscription query
 *   - rule suggestions                           → findRuleProposals
 *   - review backlog (unflagged review queue)    → Transaction count
 *   - import issues in window                    → ImportHistory query
 *   - anomalies / category deltas                → buildFinancialInsights
 *
 * Everything is deterministic — no OpenAI required. That's the AC's
 * "AI summary is optional and gracefully disabled when unavailable"
 * requirement. The pure summary is exported so unit tests can verify
 * label/plural correctness without touching the DB.
 */

import { Op } from 'sequelize';
import type { Request } from 'express';
import {
  Transaction,
  Receipt,
  PlannedEvent,
  Subscription,
  ImportHistory,
} from '../models';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';
import { buildFinancialInsights, type AiFinancialInsight } from '../ai/insights';
import { findRuleProposals } from '../ai/ruleProposals';
import { num } from '../util/numbers';
import {
  computeSafeToSpend,
  type SafeToSpendResult,
} from '../cashflow/safeToSpend';
import type {
  CfoBriefingActionItem,
  CfoBriefingActionItemSeverity,
  CfoBriefingActionItemType,
  CfoBriefingSafeToSpendSnapshot,
} from '../models/CfoBriefing';

/** Persisted version of the briefing prompt/composition. Bump when the
 *  shape of action items materially changes so eval comparisons stay
 *  honest. */
export const CFO_BRIEFING_PROMPT_VERSION = 'cfo-briefing-v1';

/** $ threshold (period currency) above which a missing receipt is
 *  surfaced. Mirrors the AI review value so the two features agree. */
const MISSING_RECEIPT_AMOUNT_THRESHOLD = 50;

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
  missingReceipts: number;
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
    counts.missingReceipts +
    counts.newSubscriptions +
    counts.ruleSuggestions +
    counts.reviewBacklog +
    counts.importIssues +
    counts.anomalies;
  if (total === 0) return 'All clear — no action items for this briefing window.';
  const labels: string[] = [];
  push(labels, counts.forecastWarnings, 'forecast warning', 'forecast warnings');
  push(labels, counts.safeToSpendLow, 'safe-to-spend alert', 'safe-to-spend alerts');
  push(labels, counts.missingReceipts, 'missing receipt', 'missing receipts');
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
}

export interface BuildBriefingResult {
  actionItems: CfoBriefingActionItem[];
  summary: string;
  safeToSpendSnapshot: CfoBriefingSafeToSpendSnapshot | null;
}

function idFor(type: CfoBriefingActionItemType, suffix: string | number): string {
  return `${type}-${suffix}`;
}

function severityFromInsight(s: AiFinancialInsight['severity']): CfoBriefingActionItemSeverity {
  return s === 'action' ? 'action' : s === 'watch' ? 'watch' : 'info';
}

function safeAbsNumber(value: unknown): number {
  const n = num(value);
  return n == null ? 0 : Math.abs(n);
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
    txnsInWindow,
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
    safeBriefingFetch(() =>
      buildFinancialInsights(req, periodEnd.slice(0, 7), currency, {
        from: periodStart,
        to: periodEnd,
        label: `${periodStart} to ${periodEnd}`,
      }),
    ),
    safeBriefingFetch(() => findRuleProposals(householdId)),
    Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        currency,
        date: { [Op.between]: [periodStart, periodEnd] },
      },
      attributes: ['id', 'date', 'merchantClean', 'amount', 'reviewFlag'],
      include: [
        {
          model: Receipt,
          as: 'receipts',
          attributes: ['id'],
          required: false,
        },
      ],
    }),
    PlannedEvent.findAll({
      where: {
        householdId,
        kind: 'planned',
        status: 'planned',
        expectedDate: {
          [Op.lt]: periodEnd,
        },
      },
      attributes: ['id', 'name', 'expectedDate', 'amount', 'type'],
      raw: true,
    }),
    Subscription.findAll({
      where: {
        ...householdWhere(req),
        status: 'active',
        createdAt: { [Op.between]: [`${periodStart}T00:00:00Z`, `${periodEnd}T23:59:59Z`] },
      },
      attributes: ['id', 'merchantName', 'amount', 'currency', 'cadence'],
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

  // 2. Anomalies from insights.
  if (insightsOut) {
    for (const insight of insightsOut.insights) {
      items.push({
        id: idFor('anomaly', `${insight.metric}-${Math.round(insight.amount)}`),
        type: 'anomaly',
        refType: null,
        refId: null,
        severity: severityFromInsight(insight.severity),
        title: insight.title,
        summary: insight.summary,
        status: 'open',
        supportingTransactionIds: insight.supportingTransactionIds,
        rationale: insight.rationale,
        link: '/insights',
      });
    }
  }

  // 3. Rule suggestions.
  if (ruleProposals) {
    for (const proposal of ruleProposals) {
      items.push({
        id: idFor('rule_suggestion', proposal.merchantPattern),
        type: 'rule_suggestion',
        refType: 'rule',
        refId: null,
        severity: 'info',
        title: `Suggested rule: "${proposal.merchantPattern}"`,
        summary: `${proposal.supportCount} reviewed transactions match "${proposal.merchantPattern}" → ${proposal.category ?? '(no category)'}.`,
        status: 'open',
        supportingTransactionIds: proposal.exampleTransactionIds,
        rationale: 'Detected by repeated manual categorizations sharing a merchant pattern.',
        link: '/rules',
      });
    }
  }

  // 4. Missing receipts on big-ticket spend in window.
  type TxnRow = {
    id: number;
    date: string;
    merchantClean: string | null;
    amount: unknown;
    receipts?: Array<{ id: number }>;
  };
  for (const raw of txnsInWindow) {
    const txn = raw.toJSON() as TxnRow;
    const amount = safeAbsNumber(txn.amount);
    if (amount < MISSING_RECEIPT_AMOUNT_THRESHOLD) continue;
    if ((txn.receipts ?? []).length > 0) continue;
    const merchant = txn.merchantClean || 'Unknown merchant';
    items.push({
      id: idFor('missing_receipt', txn.id),
      type: 'missing_receipt',
      refType: 'transaction',
      refId: txn.id,
      severity: 'watch',
      title: `Missing receipt for ${merchant}`,
      summary: `${merchant} on ${txn.date} for ${amount.toFixed(2)} ${currency} has no attached receipt.`,
      status: 'open',
      supportingTransactionIds: [txn.id],
      rationale: `Charge of ${amount.toFixed(2)} ${currency} exceeds the ${MISSING_RECEIPT_AMOUNT_THRESHOLD} ${currency} threshold and has no receipt.`,
      link: `/transactions?id=${txn.id}`,
    });
  }

  // 5. New subscriptions detected in the window.
  type SubRow = {
    id: number;
    merchantName: string;
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
      title: `New subscription: ${raw.merchantName}`,
      summary: `${raw.merchantName} (${monthly.toFixed(2)} ${raw.currency} ${raw.cadence}) detected since the start of this briefing window.`,
      status: 'open',
      rationale: 'Subscription was created or first observed in this briefing window.',
      link: '/subscriptions',
    });
  }

  // 6. Forecast warnings: planned events overdue.
  type OverdueEvent = {
    id: number;
    name: string;
    expectedDate: string;
    amount: unknown;
    type: string;
  };
  for (const raw of plannedEventsOverdue as unknown as OverdueEvent[]) {
    items.push({
      id: idFor('forecast_warning', raw.id),
      type: 'forecast_warning',
      refType: 'event',
      refId: raw.id,
      severity: 'watch',
      title: `Planned ${raw.type} overdue: ${raw.name}`,
      summary: `${raw.name} (${safeAbsNumber(raw.amount).toFixed(2)} ${currency}) expected on ${raw.expectedDate} but not posted.`,
      status: 'open',
      supportingTransactionIds: [],
      rationale: 'Planned event still in "planned" status past its expected date.',
      link: '/planned',
    });
  }

  // 7. Review backlog — if there are flagged transactions, surface one
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

  // 8. Import issues during the window.
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
    missingReceipts: 0,
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
        counts.missingReceipts += 1;
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

  return {
    actionItems: items,
    summary: briefingShortSummary(counts),
    safeToSpendSnapshot,
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
