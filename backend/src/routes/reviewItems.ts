/**
 * Unified review-items inbox (issue #378).
 *
 * GET /api/review-items
 *
 * Fans out across four source tables — AiSuggestion, AiReviewRun (action
 * items), CfoBriefing (action items), and ChatProposal — normalises each
 * row to a common ReviewItem shape, merges, and returns sorted by
 * createdAt DESC.
 *
 * Query params:
 *   status  – comma-separated CommonStatus values, default "pending"
 *   source  – comma-separated source keys, default all four
 *   limit   – integer 1-200, default 50
 *
 * Write paths (accept / reject / dismiss / resolve) are NOT touched; they
 * remain at the existing per-source endpoints.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { AiSuggestion, AiReviewRun, CfoBriefing, ChatProposal, ChatThread } from '../models';
import type {
  AiSuggestionStatus,
  AiSuggestionKind,
} from '../models/AiSuggestion';
import type { AiReviewActionItem } from '../models/AiReviewRun';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';
import type { ChatProposalStatus, ChatProposalKind } from '../models/ChatProposal';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommonStatus = 'pending' | 'resolved' | 'dismissed' | 'expired';

type ReviewItemSource =
  | 'ai-suggestion'
  | 'ai-review'
  | 'cfo-briefing'
  | 'chat-proposal';

type SubjectType =
  | 'transaction'
  | 'receipt'
  | 'rule'
  | 'event'
  | 'subscription'
  | 'import'
  | 'chat-message'
  | null;

interface ReviewItem {
  id: string;
  source: ReviewItemSource;
  subjectType: SubjectType;
  subjectId: string | null;
  payload: Record<string, unknown>;
  statusCommon: CommonStatus;
  nativeStatus: string;
  createdAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Status mappings (typed const — exhaustive per source)
// ---------------------------------------------------------------------------

const AI_SUGGESTION_STATUS_MAP: Record<AiSuggestionStatus, CommonStatus> = {
  suggested: 'pending',
  accepted: 'resolved',
  edited: 'resolved',
  rejected: 'dismissed',
  superseded: 'dismissed',
  failed: 'dismissed',
};

const AI_REVIEW_ITEM_STATUS_MAP: Record<'suggested' | 'accepted' | 'dismissed', CommonStatus> = {
  suggested: 'pending',
  accepted: 'resolved',
  dismissed: 'dismissed',
};

const CFO_BRIEFING_ITEM_STATUS_MAP: Record<'open' | 'resolved' | 'dismissed', CommonStatus> = {
  open: 'pending',
  resolved: 'resolved',
  dismissed: 'dismissed',
};

const CHAT_PROPOSAL_STATUS_MAP: Record<ChatProposalStatus, CommonStatus> = {
  pending: 'pending',
  applied: 'resolved',
  rejected: 'dismissed',
  expired: 'expired',
};

// ---------------------------------------------------------------------------
// Subject-type helpers
// ---------------------------------------------------------------------------

function aiSuggestionSubjectType(kind: AiSuggestionKind): SubjectType {
  switch (kind) {
    case 'transaction_fields':
    case 'transaction_audit':
    case 'amazon_item_categories':
      return 'transaction';
    case 'receipt_extract':
      return 'receipt';
    case 'rule_proposal':
      return 'rule';
    case 'financial_insight':
    case 'counterparty_promotion':
      return null;
    default:
      return null;
  }
}

function aiReviewRefTypeToSubjectType(
  refType: 'transaction' | 'event' | 'rule' | null,
): SubjectType {
  if (refType === 'transaction') return 'transaction';
  if (refType === 'event') return 'event';
  if (refType === 'rule') return 'rule';
  return null;
}

function cfoRefTypeToSubjectType(
  refType: 'transaction' | 'event' | 'rule' | 'subscription' | 'import' | null,
): SubjectType {
  if (refType === 'transaction') return 'transaction';
  if (refType === 'event') return 'event';
  if (refType === 'rule') return 'rule';
  if (refType === 'subscription') return 'subscription';
  if (refType === 'import') return 'import';
  return null;
}

function chatProposalKindToSubjectType(kind: ChatProposalKind): SubjectType {
  switch (kind) {
    case 'transaction_edit':
    case 'bulk_patch':
      return 'transaction';
    case 'rule_create':
    case 'rule_update':
    case 'rule_delete':
      return 'rule';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Query-param parsing
// ---------------------------------------------------------------------------

const ALL_COMMON_STATUSES: CommonStatus[] = ['pending', 'resolved', 'dismissed', 'expired'];
const ALL_SOURCES: ReviewItemSource[] = ['ai-suggestion', 'ai-review', 'cfo-briefing', 'chat-proposal'];

function parseCommaSeparated<T extends string>(
  raw: string | undefined,
  allowed: T[],
  defaultValue: T[],
): T[] {
  if (!raw) return defaultValue;
  const parsed = raw
    .split(',')
    .map((s) => s.trim() as T)
    .filter((s) => allowed.includes(s));
  return parsed.length > 0 ? parsed : defaultValue;
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// AiSuggestion native status → CommonStatus filter values
// ---------------------------------------------------------------------------

function aiSuggestionNativeStatuses(
  statuses: CommonStatus[],
): AiSuggestionStatus[] {
  const result: AiSuggestionStatus[] = [];
  for (const [native, common] of Object.entries(AI_SUGGESTION_STATUS_MAP) as [
    AiSuggestionStatus,
    CommonStatus,
  ][]) {
    if (statuses.includes(common)) result.push(native);
  }
  return result;
}

function aiReviewNativeStatuses(
  statuses: CommonStatus[],
): ('suggested' | 'accepted' | 'dismissed')[] {
  const result: ('suggested' | 'accepted' | 'dismissed')[] = [];
  for (const [native, common] of Object.entries(AI_REVIEW_ITEM_STATUS_MAP) as [
    'suggested' | 'accepted' | 'dismissed',
    CommonStatus,
  ][]) {
    if (statuses.includes(common)) result.push(native);
  }
  return result;
}

function cfoNativeStatuses(
  statuses: CommonStatus[],
): ('open' | 'resolved' | 'dismissed')[] {
  const result: ('open' | 'resolved' | 'dismissed')[] = [];
  for (const [native, common] of Object.entries(CFO_BRIEFING_ITEM_STATUS_MAP) as [
    'open' | 'resolved' | 'dismissed',
    CommonStatus,
  ][]) {
    if (statuses.includes(common)) result.push(native);
  }
  return result;
}

function chatProposalNativeStatuses(
  statuses: CommonStatus[],
): ChatProposalStatus[] {
  const result: ChatProposalStatus[] = [];
  for (const [native, common] of Object.entries(CHAT_PROPOSAL_STATUS_MAP) as [
    ChatProposalStatus,
    CommonStatus,
  ][]) {
    if (statuses.includes(common)) result.push(native);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source query functions
// ---------------------------------------------------------------------------

async function fetchAiSuggestions(
  householdId: number,
  statuses: CommonStatus[],
  limit: number,
): Promise<ReviewItem[]> {
  const nativeStatuses = aiSuggestionNativeStatuses(statuses);
  if (nativeStatuses.length === 0) return [];

  const rows = await AiSuggestion.findAll({
    where: {
      householdId,
      status: { [Op.in]: nativeStatuses },
    },
    order: [['createdAt', 'DESC']],
    limit,
  });

  return rows.map((row): ReviewItem => {
    const commonStatus = AI_SUGGESTION_STATUS_MAP[row.status] ?? 'dismissed';
    const subjectType = aiSuggestionSubjectType(row.kind);
    const subjectId =
      row.transactionId != null
        ? String(row.transactionId)
        : row.receiptId != null
          ? String(row.receiptId)
          : null;
    const resolvedAt =
      commonStatus === 'resolved' ? row.updatedAt.toISOString() : null;
    return {
      id: `ai-suggestion:${row.id}`,
      source: 'ai-suggestion',
      subjectType,
      subjectId,
      payload: {
        kind: row.kind,
        output: row.output,
        model: row.model,
        promptVersion: row.promptVersion,
      },
      statusCommon: commonStatus,
      nativeStatus: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt,
    };
  });
}

async function fetchAiReviewItems(
  householdId: number,
  statuses: CommonStatus[],
  limit: number,
): Promise<ReviewItem[]> {
  const nativeStatuses = aiReviewNativeStatuses(statuses);
  if (nativeStatuses.length === 0) return [];

  // We pull completed review runs and then filter action items by status.
  // Each action item becomes a separate ReviewItem with a compound id.
  const runs = await AiReviewRun.findAll({
    where: {
      householdId,
      status: 'completed',
    },
    order: [['createdAt', 'DESC']],
    limit,
  });

  const items: ReviewItem[] = [];
  for (const run of runs) {
    const actionItems: AiReviewActionItem[] = Array.isArray(run.actionItems)
      ? run.actionItems
      : [];
    for (const item of actionItems) {
      const nativeStatus = item.status as 'suggested' | 'accepted' | 'dismissed';
      if (!nativeStatuses.includes(nativeStatus)) continue;
      const commonStatus = AI_REVIEW_ITEM_STATUS_MAP[nativeStatus] ?? 'pending';
      const subjectType = aiReviewRefTypeToSubjectType(item.refType);
      items.push({
        id: `ai-review:${run.id}:${item.id}`,
        source: 'ai-review',
        subjectType,
        subjectId: item.refId != null ? String(item.refId) : null,
        payload: {
          runId: run.id,
          itemId: item.id,
          type: item.type,
          severity: item.severity,
          title: item.title,
          summary: item.summary,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          supportingTransactionIds: item.supportingTransactionIds,
          rationale: item.rationale,
        },
        statusCommon: commonStatus,
        nativeStatus: item.status,
        createdAt: run.createdAt.toISOString(),
        resolvedAt: commonStatus === 'resolved' ? run.updatedAt.toISOString() : null,
      });
    }
  }
  return items;
}

async function fetchCfoBriefingItems(
  householdId: number,
  statuses: CommonStatus[],
  limit: number,
): Promise<ReviewItem[]> {
  const nativeStatuses = cfoNativeStatuses(statuses);
  if (nativeStatuses.length === 0) return [];

  const runs = await CfoBriefing.findAll({
    where: {
      householdId,
      status: 'completed',
    },
    order: [['createdAt', 'DESC']],
    limit,
  });

  const items: ReviewItem[] = [];
  for (const run of runs) {
    const actionItems: CfoBriefingActionItem[] = Array.isArray(run.actionItems)
      ? run.actionItems
      : [];
    for (const item of actionItems) {
      const nativeStatus = item.status as 'open' | 'resolved' | 'dismissed';
      if (!nativeStatuses.includes(nativeStatus)) continue;
      const commonStatus = CFO_BRIEFING_ITEM_STATUS_MAP[nativeStatus] ?? 'pending';
      const subjectType = cfoRefTypeToSubjectType(item.refType);
      items.push({
        id: `cfo-briefing:${run.id}:${item.id}`,
        source: 'cfo-briefing',
        subjectType,
        subjectId: item.refId != null ? String(item.refId) : null,
        payload: {
          runId: run.id,
          itemId: item.id,
          type: item.type,
          severity: item.severity,
          title: item.title,
          summary: item.summary,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          link: item.link,
          supportingTransactionIds: item.supportingTransactionIds,
          rationale: item.rationale,
          safeToSpendSnapshot: run.safeToSpendSnapshot,
        },
        statusCommon: commonStatus,
        nativeStatus: item.status,
        createdAt: run.createdAt.toISOString(),
        resolvedAt: commonStatus === 'resolved' ? run.updatedAt.toISOString() : null,
      });
    }
  }
  return items;
}

async function fetchChatProposals(
  userId: number,
  statuses: CommonStatus[],
  limit: number,
): Promise<ReviewItem[]> {
  const nativeStatuses = chatProposalNativeStatuses(statuses);
  if (nativeStatuses.length === 0) return [];

  // ChatProposal → ChatThread → userId (no householdId on thread).
  // Scope by finding thread ids belonging to this user then loading proposals.
  const threads = await ChatThread.findAll({
    where: { userId },
    attributes: ['id'],
  });
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length === 0) return [];

  const rows = await ChatProposal.findAll({
    where: {
      threadId: { [Op.in]: threadIds },
      status: { [Op.in]: nativeStatuses },
    },
    order: [['createdAt', 'DESC']],
    limit,
  });

  return rows.map((row): ReviewItem => {
    const commonStatus = CHAT_PROPOSAL_STATUS_MAP[row.status] ?? 'pending';
    const subjectType = chatProposalKindToSubjectType(row.kind);
    const resolvedAt =
      commonStatus === 'resolved' && row.appliedAt != null
        ? row.appliedAt.toISOString()
        : null;
    return {
      id: `chat-proposal:${row.id}`,
      source: 'chat-proposal',
      subjectType,
      subjectId: null,
      payload: {
        kind: row.kind,
        preview: row.preview,
        threadId: row.threadId,
        messageId: row.messageId,
        expiresAt: row.expiresAt.toISOString(),
        appliedResult: row.appliedResult,
      },
      statusCommon: commonStatus,
      nativeStatus: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);

    // Parse query params
    const statuses = parseCommaSeparated(
      req.query.status as string | undefined,
      ALL_COMMON_STATUSES,
      ['pending'],
    );
    const sources = parseCommaSeparated(
      req.query.source as string | undefined,
      ALL_SOURCES,
      ALL_SOURCES,
    );
    const limit = parseLimit(req.query.limit);

    // Fan-out in parallel, each bounded by limit
    const [aiSuggestions, aiReviewItems, cfoItems, chatProposals] =
      await Promise.all([
        sources.includes('ai-suggestion')
          ? fetchAiSuggestions(household.id, statuses, limit)
          : Promise.resolve([]),
        sources.includes('ai-review')
          ? fetchAiReviewItems(household.id, statuses, limit)
          : Promise.resolve([]),
        sources.includes('cfo-briefing')
          ? fetchCfoBriefingItems(household.id, statuses, limit)
          : Promise.resolve([]),
        sources.includes('chat-proposal')
          ? fetchChatProposals(user.id, statuses, limit)
          : Promise.resolve([]),
      ]);

    // Merge, sort by createdAt DESC, trim to limit
    const merged = [
      ...aiSuggestions,
      ...aiReviewItems,
      ...cfoItems,
      ...chatProposals,
    ].sort((a, b) => {
      if (a.createdAt > b.createdAt) return -1;
      if (a.createdAt < b.createdAt) return 1;
      return 0;
    });

    const data = merged.slice(0, limit);

    res.json({ data, total: merged.length });
  } catch (e) {
    next(e);
  }
});

export default router;
