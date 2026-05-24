/**
 * Preview builders + applyProposal for the chat mutation tools.
 *
 * Mutation tools never touch live data. Each `build*Preview` function
 * persists a `ChatProposal` row with `status='pending'` and returns the
 * proposal id + a preview shape the UI can render. The user clicks Apply
 * in the UI, which hits `POST /api/chat/proposals/:id/apply` (Task 12)
 * and ultimately calls `applyProposal()` here.
 *
 * Visibility scoping: every Transaction lookup mirrors
 * `visibleTransactionWhere` from `src/auth/scope.ts` — household-scoped
 * AND (shared OR createdByUserId === ctx.userId) — to prevent cross-member
 * private rows from being visible to the chat tools. Rules and proposals
 * are household-scoped only (no per-row visibility).
 */
import { Op } from 'sequelize';
import {
  ChatProposal,
  ChatMessage,
  Transaction,
  Rule,
} from '../../models';
import type { ChatProposalStatus } from '../../models/ChatProposal';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';
import { caseInsensitiveLikeOp } from './_common';

const PATCH_WHITELIST = new Set([
  'split_override',
  'pct_me_override',
  'pct_partner_override',
  'category_override',
  'business_override',
  'notes',
  'review_flag',
]);

const PATCH_FIELD_MAP: Record<string, string> = {
  split_override: 'splitOverride',
  pct_me_override: 'pctMeOverride',
  pct_partner_override: 'pctPartnerOverride',
  category_override: 'categoryOverride',
  business_override: 'businessOverride',
  notes: 'notes',
  review_flag: 'reviewFlag',
};

/**
 * Maximum rows a single `propose_bulk_patch` may target. Settable via the
 * `CHAT_BULK_PATCH_LIMIT` env var so tests can exercise the filter_too_broad
 * branch without seeding 500+ rows.
 */
export function getBulkPatchLimit(): number {
  const raw = process.env.CHAT_BULK_PATCH_LIMIT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 500;
}

export interface ProposalContext {
  userId: number;
  householdId: number;
  threadId: number;
  messageId: number;
}

export interface BuildResult {
  proposal_id: number;
  preview: Record<string, unknown>;
}
export interface BuildError {
  error: string;
}
export type BuildReturn = BuildResult | BuildError;

type WhitelistOk = { ok: true; value: Record<string, unknown> };
type WhitelistErr = { ok: false; error: string };

function whitelistPatch(patch: unknown): WhitelistOk | WhitelistErr {
  if (patch == null || typeof patch !== 'object') {
    return { ok: false, error: 'patch must be an object' };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!PATCH_WHITELIST.has(k)) {
      return { ok: false, error: `field "${k}" is not in the patch whitelist` };
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: 'patch must include at least one whitelisted field' };
  }
  return { ok: true, value: out };
}

function applyPatchToTxn(txn: Transaction, snakePatch: Record<string, unknown>) {
  for (const [snake, value] of Object.entries(snakePatch)) {
    const camel = PATCH_FIELD_MAP[snake];
    if (camel) txn.set(camel as keyof Transaction['_attributes'], value as never);
  }
}

function expiresAt(): Date {
  const hours = getChatConfig().proposalExpiryHours;
  return new Date(Date.now() + hours * 3600 * 1000);
}

/**
 * Build the visibility-OR clause that mirrors visibleTransactionWhere from
 * src/auth/scope.ts. Keeps cross-member private rows out of every transaction
 * lookup made by the proposal builders or applyProposal.
 */
function visibilityOr(ctx: ProposalContext): Array<Record<string, unknown>> {
  return [{ visibility: 'shared' }, { createdByUserId: ctx.userId }];
}

// ============================================================================
// transaction_edit
// ============================================================================
export async function buildTransactionEditPreview(
  transactionId: number,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<BuildReturn> {
  const cleaned = whitelistPatch(patch);
  if (!cleaned.ok) return { error: cleaned.error };
  const where: Record<string, unknown> = {
    id: transactionId,
    householdId: ctx.householdId,
    [Op.or]: visibilityOr(ctx),
  };
  const txn = await Transaction.findOne({ where });
  if (!txn) return { error: `transaction ${transactionId} not visible to user` };
  const before = txn.toJSON();
  // Simulate the patch on a clone to compute "after" without mutating the row.
  const afterMock = txn.toJSON() as Record<string, unknown>;
  for (const [snake, value] of Object.entries(cleaned.value)) {
    const camel = PATCH_FIELD_MAP[snake];
    if (camel) afterMock[camel] = value;
  }
  const preview = { before, after: afterMock };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'transaction_edit',
    payload: { transaction_id: transactionId, patch: cleaned.value },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

// ============================================================================
// bulk_patch
// ============================================================================
export async function buildBulkPatchPreview(
  filter: Record<string, unknown>,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<BuildReturn> {
  const cleaned = whitelistPatch(patch);
  if (!cleaned.ok) return { error: cleaned.error };
  const where = buildBulkFilterWhere(filter, ctx);
  const matchedCount = await Transaction.count({ where });
  const limit = getBulkPatchLimit();
  if (matchedCount > limit) {
    return {
      error: `filter_too_broad: ${matchedCount} rows match; reduce the scope (max ${limit}).`,
    };
  }
  const sample = await Transaction.findAll({
    where,
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 10,
  });
  const sampleWithDiff = sample.map((r) => {
    const before = r.toJSON();
    const after = { ...before } as Record<string, unknown>;
    for (const [snake, value] of Object.entries(cleaned.value)) {
      const camel = PATCH_FIELD_MAP[snake];
      if (camel) after[camel] = value;
    }
    return { before, after };
  });
  const preview = {
    matched_count: matchedCount,
    filter_summary: summarizeFilter(filter),
    sample: sampleWithDiff,
  };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'bulk_patch',
    payload: { filter, patch: cleaned.value },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

function buildBulkFilterWhere(
  filter: Record<string, unknown>,
  ctx: ProposalContext
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    householdId: ctx.householdId,
    [Op.or]: visibilityOr(ctx),
  };
  if (typeof filter.merchant_pattern === 'string') {
    where.merchantClean = {
      [caseInsensitiveLikeOp()]: `%${filter.merchant_pattern}%`,
    };
  }
  if (typeof filter.category === 'string') where.finalCategory = filter.category;
  if (typeof filter.currency === 'string') where.currency = filter.currency;
  if (typeof filter.account_id === 'number') where.accountId = filter.account_id;
  if (typeof filter.split_type === 'string') where.finalSplitType = filter.split_type;
  const dateRange: Record<string, unknown> = {};
  if (typeof filter.date_from === 'string') dateRange[Op.gte as unknown as string] = filter.date_from;
  if (typeof filter.date_to === 'string') dateRange[Op.lte as unknown as string] = filter.date_to;
  if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
  return where;
}

function summarizeFilter(filter: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v != null) parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.join(', ');
}

// ============================================================================
// rule_create / update / delete
// ============================================================================
export async function buildRuleCreatePreview(
  body: Record<string, unknown>,
  ctx: ProposalContext
): Promise<BuildReturn> {
  // Minimal validation; the actual Rule.create at apply-time will enforce more.
  if (!body.merchant_pattern || typeof body.merchant_pattern !== 'string') {
    return { error: 'merchant_pattern is required' };
  }
  // Estimate how many EXISTING transactions in the effective window would match.
  // Visibility-scoped so a member can't probe the existence of cross-member
  // private rows via the would_affect count.
  const where: Record<string, unknown> = {
    householdId: ctx.householdId,
    [Op.or]: visibilityOr(ctx),
    merchantClean: {
      [caseInsensitiveLikeOp()]: `%${body.merchant_pattern as string}%`,
    },
  };
  const dateRange: Record<string, unknown> = {};
  if (typeof body.effective_from === 'string') dateRange[Op.gte as unknown as string] = body.effective_from;
  if (typeof body.effective_to === 'string') dateRange[Op.lt as unknown as string] = body.effective_to;
  if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
  const wouldAffect = await Transaction.count({ where });
  const preview = {
    rule_preview: body,
    would_affect_existing_count: wouldAffect,
  };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_create',
    payload: body,
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

export async function buildRuleUpdatePreview(
  ruleId: number,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<BuildReturn> {
  const where: Record<string, unknown> = { id: ruleId, householdId: ctx.householdId };
  const rule = await Rule.findOne({ where });
  if (!rule) return { error: `rule ${ruleId} not visible to user` };
  const before = rule.toJSON();
  const after = { ...before, ...patch } as Record<string, unknown>;
  const mergedPattern = String(
    (after.merchantPattern ?? after.merchant_pattern) ?? ''
  );
  const txWhere: Record<string, unknown> = {
    householdId: ctx.householdId,
    [Op.or]: visibilityOr(ctx),
    merchantClean: {
      [caseInsensitiveLikeOp()]: `%${mergedPattern}%`,
    },
  };
  const wouldAffect = await Transaction.count({ where: txWhere });
  const preview = { before, after, would_affect_existing_count: wouldAffect };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_update',
    payload: { rule_id: ruleId, patch },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

export async function buildRuleDeletePreview(
  ruleId: number,
  ctx: ProposalContext
): Promise<BuildReturn> {
  const where: Record<string, unknown> = { id: ruleId, householdId: ctx.householdId };
  const rule = await Rule.findOne({ where });
  if (!rule) return { error: `rule ${ruleId} not visible to user` };
  const preview = { rule_summary: rule.toJSON() };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_delete',
    payload: { rule_id: ruleId },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

// ============================================================================
// applyProposal — used by /api/chat/proposals/:id/apply (Task 12)
// ============================================================================
export interface ApplyResult {
  ok: true;
  status: ChatProposalStatus;
  result: Record<string, unknown>;
}
export interface ApplyError {
  ok: false;
  code: 'not_pending' | 'expired' | 'count_drifted' | 'not_found';
  message: string;
  extra?: Record<string, unknown>;
}

export async function applyProposal(
  proposalId: number,
  ctx: ProposalContext
): Promise<ApplyResult | ApplyError> {
  return sequelize.transaction(async (t) => {
    const proposal = await ChatProposal.findOne({
      where: { id: proposalId, threadId: ctx.threadId },
      transaction: t,
    });
    if (!proposal) {
      return {
        ok: false as const,
        code: 'not_found',
        message: 'proposal not found in this thread',
      };
    }
    if (proposal.status === 'expired' || proposal.expiresAt.getTime() < Date.now()) {
      if (proposal.status !== 'expired') {
        proposal.set('status', 'expired');
        await proposal.save({ transaction: t });
      }
      return { ok: false as const, code: 'expired', message: 'proposal expired' };
    }
    if (proposal.status !== 'pending') {
      return {
        ok: false as const,
        code: 'not_pending',
        message: `proposal status is "${proposal.status}"`,
      };
    }

    let result: Record<string, unknown>;
    switch (proposal.kind) {
      case 'transaction_edit':
        result = await applyTransactionEdit(proposal, ctx, t);
        break;
      case 'bulk_patch': {
        const driftCheck = await checkBulkDrift(proposal, ctx, t);
        if ('code' in driftCheck && driftCheck.code === 'count_drifted') {
          return driftCheck;
        }
        result = await applyBulkPatch(proposal, ctx, t);
        break;
      }
      case 'rule_create':
        result = await applyRuleCreate(proposal, ctx, t);
        break;
      case 'rule_update':
        result = await applyRuleUpdate(proposal, ctx, t);
        break;
      case 'rule_delete':
        result = await applyRuleDelete(proposal, ctx, t);
        break;
      default:
        return {
          ok: false as const,
          code: 'not_pending',
          message: `unknown kind: ${proposal.kind as string}`,
        };
    }

    proposal.set('status', 'applied');
    proposal.set('appliedAt', new Date());
    proposal.set('appliedResult', result);
    await proposal.save({ transaction: t });

    // Append a role=tool message describing what happened (so the LLM sees it
    // on the next user turn).
    await ChatMessage.create(
      {
        threadId: ctx.threadId,
        role: 'tool',
        contentText: JSON.stringify({ applied: proposal.kind, result }),
        toolCalls: null,
        toolCallId: `proposal_${proposalId}`,
        toolName: `apply_${proposal.kind}`,
        model: null,
        promptTokens: null,
        completionTokens: null,
        latencyMs: null,
        providerRequestId: null,
      },
      { transaction: t }
    );

    return { ok: true as const, status: 'applied', result };
  });
}

async function applyTransactionEdit(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as {
    transaction_id: number;
    patch: Record<string, unknown>;
  };
  const where: Record<string, unknown> = {
    id: payload.transaction_id,
    householdId: ctx.householdId,
    [Op.or]: visibilityOr(ctx),
  };
  const txn = await Transaction.findOne({ where, transaction: t });
  if (!txn) throw new Error(`transaction ${payload.transaction_id} disappeared`);
  applyPatchToTxn(txn, payload.patch);
  await txn.save({ transaction: t });
  return { updated_id: payload.transaction_id };
}

async function checkBulkDrift(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<ApplyError | { code: 'ok' }> {
  const payload = proposal.payload as { filter: Record<string, unknown> };
  const where = buildBulkFilterWhere(payload.filter, ctx);
  const currentCount = await Transaction.count({ where, transaction: t });
  const previewCount =
    (proposal.preview as { matched_count?: number }).matched_count ?? 0;
  const drift = getChatConfig().proposalDriftPct;
  const denom = Math.max(previewCount, 1);
  const observed = Math.abs(currentCount - previewCount) / denom;
  if (observed > drift) {
    return {
      ok: false,
      code: 'count_drifted',
      message: `matched count drifted from ${previewCount} to ${currentCount}`,
      extra: { preview_count: previewCount, current_count: currentCount },
    };
  }
  return { code: 'ok' };
}

async function applyBulkPatch(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as {
    filter: Record<string, unknown>;
    patch: Record<string, unknown>;
  };
  const where = buildBulkFilterWhere(payload.filter, ctx);
  const matched = await Transaction.findAll({ where, transaction: t });
  for (const txn of matched) {
    applyPatchToTxn(txn, payload.patch);
    await txn.save({ transaction: t });
  }
  return { updated_count: matched.length, ids: matched.map((m) => m.id) };
}

async function applyRuleCreate(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const body = proposal.payload as Record<string, unknown>;
  const row = await Rule.create(
    {
      merchantPattern: String(body.merchant_pattern),
      matchKind: typeof body.match_kind === 'string' ? body.match_kind : 'substring',
      priority: typeof body.priority === 'number' ? body.priority : 0,
      category: typeof body.category === 'string' ? body.category : null,
      isBusiness: Boolean(body.is_business),
      splitType: typeof body.split_type === 'string' ? body.split_type : 'me',
      pctMe: body.pct_me != null ? String(body.pct_me) : null,
      pctPartner: body.pct_partner != null ? String(body.pct_partner) : null,
      effectiveFrom:
        typeof body.effective_from === 'string' ? body.effective_from : null,
      effectiveTo:
        typeof body.effective_to === 'string' ? body.effective_to : null,
      householdId: ctx.householdId,
      createdByUserId: ctx.userId,
    },
    { transaction: t }
  );
  return { rule_id: row.id };
}

async function applyRuleUpdate(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as {
    rule_id: number;
    patch: Record<string, unknown>;
  };
  const where: Record<string, unknown> = {
    id: payload.rule_id,
    householdId: ctx.householdId,
  };
  const rule = await Rule.findOne({ where, transaction: t });
  if (!rule) throw new Error(`rule ${payload.rule_id} disappeared`);
  for (const [k, v] of Object.entries(payload.patch)) {
    // Convert snake_case keys from the LLM to the model's camelCase fields.
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    rule.set(camel as keyof Rule['_attributes'], v as never);
  }
  await rule.save({ transaction: t });
  return { rule_id: payload.rule_id };
}

async function applyRuleDelete(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as { rule_id: number };
  const where: Record<string, unknown> = {
    id: payload.rule_id,
    householdId: ctx.householdId,
  };
  const rule = await Rule.findOne({ where, transaction: t });
  if (!rule) throw new Error(`rule ${payload.rule_id} disappeared`);
  await rule.destroy({ transaction: t });
  return { deleted_rule_id: payload.rule_id };
}
