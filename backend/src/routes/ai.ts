import { Router, type Request } from 'express';
import { Op, QueryTypes, Transaction as SqlTransaction } from 'sequelize';
import { AiSuggestion, Rule, Transaction } from '../models';
import { sequelize } from '../models';
import { getOpenAiConfig } from '../config/openai';
import { isDemoUserRequest } from '../demo/aiAccess';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { currentAuth } from '../auth/middleware';
import { isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { loadCategoryHints, suggestTransactionFieldsTracked } from '../ai/suggestTransaction';
import {
  aiSuggestionWhere,
  applyTransactionSuggestion,
  createTrackedSuggestion,
} from '../ai/suggestionStore';
import { findRuleProposals, merchantPatternFor } from '../ai/ruleProposals';
import { buildFinancialInsights } from '../ai/insights';
import { auditTransactionsForMislabels } from '../ai/auditTransactions';
import { aiSuggestLimiter } from './aiRateLimit';
import { jsonExtractText } from '../util/dialectSql';

const router = Router();

router.get('/status', (req, res) => {
  res.json({
    openai: !isDemoUserRequest(req) && getOpenAiConfig() != null,
  });
});

router.post('/transactions/suggest', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const idsRaw = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (idsRaw.length > 15) {
      res.status(400).json({ error: 'At most 15 ids per AI request' });
      return;
    }
    const ids = idsRaw.map((v) => Number(v));
    if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
      res.status(400).json({ error: 'Each id must be a positive integer' });
      return;
    }
    const hints = await loadCategoryHints(
      isSuperadmin(req) ? null : currentAuth(req).household.id,
    );
    const results = [];
    for (const id of ids) {
      const txn = await Transaction.findOne({
        where: { id, ...visibleTransactionWhere(req) },
      });
      if (!txn) {
        res.status(404).json({ error: `Transaction ${id} not found` });
        return;
      }
      const tracked = await suggestTransactionFieldsTracked(txn, hints);
      const row = await createTrackedSuggestion({
        req,
        transactionId: txn.id,
        kind: 'transaction_fields',
        inputSnapshot: tracked.inputSnapshot,
        output: tracked.suggestion,
        model: tracked.meta.model,
        promptVersion: tracked.promptVersion,
        temperature: tracked.meta.temperature,
        latencyMs: tracked.meta.latencyMs,
        providerRequestId: tracked.meta.providerRequestId,
      });
      results.push({ id, suggestionId: row.id, suggestion: tracked.suggestion });
    }
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

router.post('/transactions/audit', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const idsRaw = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (idsRaw.length > 25) {
      res.status(400).json({ error: 'At most 25 ids per AI audit' });
      return;
    }
    const ids = idsRaw.map((v) => Number(v));
    if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
      res.status(400).json({ error: 'Each id must be a positive integer' });
      return;
    }
    const [hints, txns] = await Promise.all([
      loadCategoryHints(isSuperadmin(req) ? null : currentAuth(req).household.id),
      Promise.all(
        ids.map((id) =>
          Transaction.findOne({
            where: { id, ...visibleTransactionWhere(req) },
          }),
        ),
      ),
    ]);
    const missingId = ids.find((_id, index) => !txns[index]);
    if (missingId) {
      res.status(404).json({ error: `Transaction ${missingId} not found` });
      return;
    }
    const audit = await auditTransactionsForMislabels(
      txns.filter((txn): txn is Transaction => txn != null),
      hints,
    );
    const row = await createTrackedSuggestion({
      req,
      kind: 'transaction_audit',
      inputSnapshot: audit.inputSnapshot,
      output: { issues: audit.issues },
      model: audit.meta.model,
      promptVersion: audit.promptVersion,
      temperature: audit.meta.temperature,
      latencyMs: audit.meta.latencyMs,
      providerRequestId: audit.meta.providerRequestId,
    });
    res.json({ auditId: row.id, issues: audit.issues });
  } catch (e) {
    next(e);
  }
});

router.get('/suggestions', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...aiSuggestionWhere(req) };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.kind) where.kind = String(req.query.kind);
    if (req.query.transactionId) where.transactionId = Number(req.query.transactionId);
    const rows = await AiSuggestion.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
    });
    res.json({ suggestions: rows });
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/apply', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const transaction = await applyTransactionSuggestion(req, id);
    res.json({ transaction });
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/reject', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await AiSuggestion.findOne({ where: { id, ...aiSuggestionWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Suggestion not found' });
      return;
    }
    await row.update({ status: 'rejected' });
    res.json({ suggestion: row });
  } catch (e) {
    next(e);
  }
});

router.get('/evals/summary', async (req, res, next) => {
  try {
    const rows = await AiSuggestion.findAll({
      where: { ...aiSuggestionWhere(req), kind: 'transaction_fields' },
      attributes: ['status', 'promptVersion', 'model'],
      raw: true,
    });
    const byStatus = new Map<string, number>();
    const byPromptVersion = new Map<string, number>();
    for (const row of rows as unknown as Array<{ status: string; promptVersion: string | null }>) {
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
      byPromptVersion.set(
        row.promptVersion ?? 'unknown',
        (byPromptVersion.get(row.promptVersion ?? 'unknown') ?? 0) + 1,
      );
    }
    res.json({
      total: rows.length,
      byStatus: Object.fromEntries(byStatus),
      byPromptVersion: Object.fromEntries(byPromptVersion),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/rule-proposals', async (req, res, next) => {
  try {
    const proposals = await findRuleProposals(
      isSuperadmin(req) ? null : currentAuth(req).household.id,
    );
    res.json({ proposals });
  } catch (e) {
    next(e);
  }
});

router.post('/rule-proposals/:merchantPattern/approve', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const b = (req.body || {}) as Record<string, unknown>;
    const row = await Rule.create({
      merchantPattern: decodeURIComponent(req.params.merchantPattern),
      householdId: household.id,
      createdByUserId: user.id,
      matchKind: 'substring',
      priority: Number(b.priority ?? 0),
      category: (b.category as string | null) ?? null,
      isBusiness: Boolean(b.isBusiness),
      splitType: (b.splitType as string) || 'me',
      pctMe: b.pctMe != null ? String(b.pctMe) : null,
      pctPartner: b.pctPartner != null ? String(b.pctPartner) : null,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.post('/rule-proposals/:merchantPattern/dismiss', async (req, res, next) => {
  try {
    const raw = decodeURIComponent(req.params.merchantPattern);
    const merchantPattern = merchantPatternFor(raw);
    if (!merchantPattern) {
      res.status(400).json({ error: 'merchantPattern is required' });
      return;
    }
    const row = await createTrackedSuggestion({
      req,
      kind: 'rule_proposal',
      inputSnapshot: { merchantPattern },
      output: null,
      status: 'rejected',
      model: 'deterministic',
      promptVersion: 'rule-proposal-dismiss-v1',
    });
    res.status(201).json({ ok: true, id: row.id });
  } catch (e) {
    next(e);
  }
});

router.get('/insights', async (req, res, next) => {
  try {
    const period = String(req.query.period || new Date().toISOString().slice(0, 7));
    const currency = String(req.query.currency || 'CAD').toUpperCase().slice(0, 3);
    const dateFrom =
      typeof req.query.dateFrom === 'string' && req.query.dateFrom.trim()
        ? req.query.dateFrom.trim()
        : null;
    const dateTo =
      typeof req.query.dateTo === 'string' && req.query.dateTo.trim()
        ? req.query.dateTo.trim()
        : null;
    const hasExplicitRange =
      Object.prototype.hasOwnProperty.call(req.query, 'dateFrom') ||
      Object.prototype.hasOwnProperty.call(req.query, 'dateTo');
    const out = await buildFinancialInsights(
      req,
      period,
      currency,
      hasExplicitRange ? { from: dateFrom, to: dateTo } : undefined,
    );

    await sequelize.transaction(async (transaction) => {
      await AiSuggestion.update(
        { status: 'superseded' },
        {
          where: {
            ...aiSuggestionWhere(req),
            kind: 'financial_insight',
            status: 'suggested',
            [Op.and]: [
              sequelize.literal(`${jsonExtractText('input_snapshot', 'period')} = ${sequelize.escape(out.period)}`),
              sequelize.literal(`${jsonExtractText('input_snapshot', 'currency')} = ${sequelize.escape(currency)}`),
            ],
          },
          transaction,
        },
      );

      await createTrackedSuggestion({
        req,
        kind: 'financial_insight',
        inputSnapshot: { period: out.period, currency },
        output: out.insights,
        model: 'deterministic',
        promptVersion: 'financial-insights-v1',
        temperature: null,
        transaction,
      });
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.get('/import-cleanup', async (req, res, next) => {
  try {
    const batch = String(req.query.batch || '').trim();
    const currency = req.query.currency
      ? String(req.query.currency).toUpperCase().slice(0, 3)
      : null;
    const where = {
      ...visibleTransactionWhere(req),
      ...(batch ? { importBatch: batch } : {}),
      ...(currency ? { currency } : {}),
    };
    const rows = await Transaction.findAll({
      where,
      attributes: [
        'id',
        'date',
        'merchantClean',
        'amount',
        'currency',
        'autoCategory',
        'finalCategory',
        'reviewFlag',
        'appliedRuleId',
      ],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 200,
      raw: true,
    });
    type CleanupRow = {
      id: number;
      date: string;
      merchantClean: string;
      amount: unknown;
      currency: string;
      autoCategory: string | null;
      finalCategory: string | null;
      reviewFlag: boolean;
      appliedRuleId: number | null;
    };
    const typed = rows as unknown as CleanupRow[];
    const readyToConfirm = typed.filter((row) => row.reviewFlag && row.autoCategory);
    const needsCategory = typed.filter((row) => row.reviewFlag && !row.autoCategory);
    const alreadyReviewed = typed.filter((row) => !row.reviewFlag);
    const topReady = readyToConfirm.slice(0, 25).map((row) => ({
      id: row.id,
      date: row.date,
      merchant: row.merchantClean,
      amount: Number(row.amount),
      currency: row.currency,
      category: row.autoCategory ?? row.finalCategory,
      source: row.appliedRuleId ? 'rule' : 'merchant_memory',
    }));
    const batches = await sequelize.query<{ importBatch: string; count: string }>(
      `SELECT import_batch AS importBatch, COUNT(*) AS count
       FROM transactions
       WHERE ${isSuperadmin(req) ? '1=1' : 'household_id = ?'}
       GROUP BY import_batch
       ORDER BY MAX(date) DESC
       LIMIT 20`,
      {
        replacements: isSuperadmin(req) ? [] : [currentAuth(req).household.id],
        type: QueryTypes.SELECT,
      },
    );
    res.json({
      batch: batch || null,
      total: typed.length,
      readyToConfirmCount: readyToConfirm.length,
      needsCategoryCount: needsCategory.length,
      alreadyReviewedCount: alreadyReviewed.length,
      topReady,
      batches: batches.map((row) => ({
        importBatch: row.importBatch,
        count: Number(row.count) || 0,
      })),
    });
  } catch (e) {
    next(e);
  }
});

type InboxItem = {
  id: number;
  kind: 'transaction_audit' | 'financial_insight' | 'rule_proposal';
  createdAt: string;
  transactionId: number | null;
  summary: string;
  severity: 'action' | 'watch' | 'info' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  output: unknown;
};

function auditIssueCount(output: unknown): number {
  const issues = (output as { issues?: unknown[] } | null)?.issues;
  return Array.isArray(issues) ? issues.length : 0;
}

function summarizeAudit(output: unknown): string {
  const count = auditIssueCount(output);
  return count === 1 ? '1 issue found' : `${count} issues found`;
}

type InsightSeverity = 'action' | 'watch' | 'info';

function summarizeInsight(output: unknown): { summary: string; severity: InsightSeverity | null } {
  const arr = Array.isArray(output) ? (output as Array<{ title?: unknown; severity?: unknown }>) : [];
  if (arr.length === 0) return { summary: 'No insights', severity: null };
  const first = arr[0];
  const title = typeof first?.title === 'string' ? first.title : 'Insight';
  const counts: Record<InsightSeverity, number> = { action: 0, watch: 0, info: 0 };
  let topSeverity: InsightSeverity | null = null;
  for (const item of arr) {
    const s = item?.severity;
    if (s === 'action' || s === 'watch' || s === 'info') {
      counts[s] += 1;
      if (topSeverity === null) topSeverity = s;
      else if (s === 'action' && topSeverity !== 'action') topSeverity = 'action';
      else if (s === 'watch' && topSeverity === 'info') topSeverity = 'watch';
    }
  }
  const parts: string[] = [];
  if (counts.action > 0) parts.push(`${counts.action} action`);
  if (counts.watch > 0) parts.push(`${counts.watch} watch`);
  if (counts.info > 0) parts.push(`${counts.info} info`);
  const breakdown = arr.length > 1 && parts.length > 0 ? ` · ${parts.join(', ')}` : '';
  return { summary: `${title}${breakdown}`, severity: topSeverity };
}

async function supersedeFinancialInsightDupes(
  req: Request,
  transaction?: SqlTransaction,
): Promise<void> {
  const periodExpr = jsonExtractText('input_snapshot', 'period');
  const currencyExpr = jsonExtractText('input_snapshot', 'currency');
  const householdClause = isSuperadmin(req)
    ? ''
    : `AND household_id = ${sequelize.escape(currentAuth(req).household.id)}`;
  await sequelize.query(
    `UPDATE ai_suggestions
     SET status = 'superseded'
     WHERE kind = 'financial_insight'
       AND status = 'suggested'
       ${householdClause}
       AND id NOT IN (
         SELECT MAX(id) FROM ai_suggestions
         WHERE kind = 'financial_insight' AND status = 'suggested'
         ${householdClause}
         GROUP BY household_id, ${periodExpr}, ${currencyExpr}
       )`,
    { transaction },
  );
}

router.get('/inbox', async (req, res, next) => {
  try {
    await supersedeFinancialInsightDupes(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = { ...aiSuggestionWhere(req), status: 'suggested' as const };
    const [rows, ruleProposals] = await Promise.all([
      AiSuggestion.findAll({
        where: { ...where, kind: ['transaction_audit', 'financial_insight'] },
        order: [['id', 'DESC']],
        limit,
      }),
      findRuleProposals(isSuperadmin(req) ? null : currentAuth(req).household.id),
    ]);
    const persistedItems: InboxItem[] = [];
    for (const row of rows) {
      if (row.kind === 'transaction_audit') {
        if (auditIssueCount(row.output) === 0) continue;
        persistedItems.push({
          id: row.id,
          kind: 'transaction_audit',
          createdAt: row.createdAt.toISOString(),
          transactionId: row.transactionId,
          summary: summarizeAudit(row.output),
          severity: null,
          confidence: null,
          output: row.output,
        });
        continue;
      }
      const { summary, severity } = summarizeInsight(row.output);
      persistedItems.push({
        id: row.id,
        kind: 'financial_insight',
        createdAt: row.createdAt.toISOString(),
        transactionId: row.transactionId,
        summary,
        severity,
        confidence: null,
        output: row.output,
      });
    }
    const proposalItems: InboxItem[] = ruleProposals.map((p, idx) => ({
      id: -1 - idx,
      kind: 'rule_proposal',
      createdAt: new Date().toISOString(),
      transactionId: null,
      summary: `${p.merchantPattern} → ${p.category ?? '(no category)'} (×${p.supportCount})`,
      severity: null,
      confidence: null,
      output: p,
    }));
    res.json({ items: [...persistedItems, ...proposalItems] });
  } catch (e) {
    next(e);
  }
});

router.get('/inbox/count', async (req, res, next) => {
  try {
    await supersedeFinancialInsightDupes(req);
    const where = { ...aiSuggestionWhere(req), status: 'suggested' as const };
    const [auditRows, insightCount, ruleProposals] = await Promise.all([
      AiSuggestion.findAll({
        where: { ...where, kind: 'transaction_audit' },
        attributes: ['id', 'output'],
      }),
      AiSuggestion.count({ where: { ...where, kind: 'financial_insight' } }),
      findRuleProposals(isSuperadmin(req) ? null : currentAuth(req).household.id),
    ]);
    const auditCount = auditRows.filter((r) => auditIssueCount(r.output) > 0).length;
    const ruleProposalCount = ruleProposals.length;
    res.json({
      total: auditCount + insightCount + ruleProposalCount,
      byKind: {
        transaction_audit: auditCount,
        financial_insight: insightCount,
        rule_proposal: ruleProposalCount,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;

