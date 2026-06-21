/**
 * Unified review-items read endpoint (issue #378).
 *
 *   GET /api/review-items
 *     ?status  csv of common statuses (pending|resolved|dismissed|expired),
 *              default "pending"
 *     ?source  csv of sources (ai-suggestion|ai-review|cfo-briefing|chat-proposal),
 *              default all
 *     ?limit   1..200, default 50
 *     ?cursor  opaque pagination cursor
 *
 * Read-only. Fans out across the four source tables in parallel, normalizes
 * each into the common {@link ReviewItem} shape, merges + sorts by created_at
 * desc, then applies cursor pagination. Write paths (apply/reject/accept/
 * dismiss/resolve) stay on their per-source routers — nothing here mutates.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { AiSuggestion, AiReviewRun, CfoBriefing, ChatProposal, ChatThread } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { aiSuggestionWhere } from '../ai/suggestionStore';
import { isSuperadmin } from '../auth/scope';
import {
  REVIEW_ITEM_SOURCES,
  type ReviewItem,
  type ReviewItemSource,
  type ReviewItemCommonStatus,
  normalizeAiSuggestion,
  normalizeChatProposal,
  normalizeReviewRunItems,
  normalizeCfoBriefingItems,
  mergeAndSort,
  encodeCursor,
  decodeCursor,
} from '../reviewItems/normalize';

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const COMMON_STATUSES: readonly ReviewItemCommonStatus[] = [
  'pending',
  'resolved',
  'dismissed',
  'expired',
];

function parseCsv<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (raw == null || raw === '') return [...fallback];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = parts.filter((p): p is T => (allowed as readonly string[]).includes(p));
  return valid.length > 0 ? valid : [...fallback];
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Each source is read independently and bounded so a single noisy source can't
 * starve others. We re-read up to `cap` rows (offset + limit) and slice after
 * the global merge — simple and correct for inbox-scale data.
 */
async function readAiSuggestions(
  req: import('express').Request,
  cap: number,
): Promise<ReviewItem[]> {
  const rows = await AiSuggestion.findAll({
    where: aiSuggestionWhere(req),
    order: [['createdAt', 'DESC']],
    limit: cap,
  });
  return rows.map((row) =>
    normalizeAiSuggestion({
      id: row.id,
      kind: row.kind,
      status: row.status,
      transactionId: row.transactionId,
      receiptId: row.receiptId,
      output: row.output,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
}

async function readReviewRuns(
  req: import('express').Request,
  cap: number,
): Promise<ReviewItem[]> {
  // A run holds many action items; read enough runs to cover the cap of items.
  const rows = await AiReviewRun.findAll({
    where: householdWhere(req),
    order: [['createdAt', 'DESC']],
    limit: cap,
  });
  return rows.flatMap((row) =>
    normalizeReviewRunItems({
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      actionItems: row.actionItems,
    }),
  );
}

async function readCfoBriefings(
  req: import('express').Request,
  cap: number,
): Promise<ReviewItem[]> {
  const rows = await CfoBriefing.findAll({
    where: householdWhere(req),
    order: [['createdAt', 'DESC']],
    limit: cap,
  });
  return rows.flatMap((row) =>
    normalizeCfoBriefingItems({
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      actionItems: row.actionItems,
    }),
  );
}

async function readChatProposals(
  req: import('express').Request,
  cap: number,
): Promise<ReviewItem[]> {
  // ChatProposal has no householdId; it is scoped per-user via its thread.
  // Superadmin sees all (matches the other sources' superadmin behavior).
  let threadIds: number[] | null = null;
  if (!isSuperadmin(req)) {
    const { user } = currentAuth(req);
    const threads = await ChatThread.findAll({
      where: { userId: user.id },
      attributes: ['id'],
    });
    threadIds = threads.map((t) => t.id);
    if (threadIds.length === 0) return [];
  }
  const where = threadIds == null ? {} : { threadId: { [Op.in]: threadIds } };
  const rows = await ChatProposal.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: cap,
  });
  return rows.map((row) =>
    normalizeChatProposal({
      id: row.id,
      messageId: row.messageId,
      kind: row.kind,
      status: row.status,
      payload: row.payload,
      preview: row.preview,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
}

const READERS: Record<
  ReviewItemSource,
  (req: import('express').Request, cap: number) => Promise<ReviewItem[]>
> = {
  'ai-suggestion': readAiSuggestions,
  'ai-review': readReviewRuns,
  'cfo-briefing': readCfoBriefings,
  'chat-proposal': readChatProposals,
};

router.get('/', async (req, res, next) => {
  try {
    const statuses = parseCsv<ReviewItemCommonStatus>(
      req.query.status,
      COMMON_STATUSES,
      ['pending'],
    );
    const sources = parseCsv<ReviewItemSource>(
      req.query.source,
      REVIEW_ITEM_SOURCES,
      REVIEW_ITEM_SOURCES,
    );
    const limit = parseLimit(req.query.limit);
    const { offset } = decodeCursor(
      typeof req.query.cursor === 'string' ? req.query.cursor : null,
    );

    // Bound each source read so we can satisfy the requested page after merge.
    const cap = offset + limit + 1;
    const statusSet = new Set<ReviewItemCommonStatus>(statuses);

    const perSource = await Promise.all(sources.map((s) => READERS[s](req, cap)));
    const all = perSource.flat().filter((item) => statusSet.has(item.status_common));

    const sorted = mergeAndSort(all);
    const page = sorted.slice(offset, offset + limit);
    const hasMore = sorted.length > offset + limit;
    const nextCursor = hasMore ? encodeCursor({ offset: offset + limit }) : null;

    res.json({ data: page, nextCursor });
  } catch (e) {
    next(e);
  }
});

export default router;
