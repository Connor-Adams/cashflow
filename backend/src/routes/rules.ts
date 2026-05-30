import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { Rule, Transaction, sequelize } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { scheduleInternalBackfill } from '../import/backfillCoordinator';
import {
  findAutoRuleSuggestions,
  findRuleProposals,
  merchantPatternFor,
  type AutoRuleSuggestion,
} from '../ai/ruleProposals';
import { createTrackedSuggestion } from '../ai/suggestionStore';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  diffPatchableFields,
  recordAudit,
} from '../audit/log';
import {
  FINANCE_EVENT_TYPES,
  FINANCE_EVENT_ENTITY_TYPES,
  recordFinanceEvent,
} from '../events/financeEvents';

/**
 * Map a rule's shape to the InternalBackfillRequest parameters. Regex
 * patterns can't be expressed as SQL LIKE so we drop the merchant filter
 * and re-enrich the whole effective-date range — correct but heavier.
 * Exported for unit tests; the route uses it via scheduleRuleBackfill below.
 */
export function ruleToBackfillScope(rule: {
  merchantPattern: string;
  matchKind: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}): { merchantPattern: string | null; dateFrom: string | null; dateTo: string | null } {
  const merchantPattern =
    rule.matchKind === 'regex' || !rule.merchantPattern ? null : rule.merchantPattern;
  return {
    merchantPattern,
    dateFrom: rule.effectiveFrom,
    dateTo: rule.effectiveTo,
  };
}

function scheduleRuleBackfill(
  householdId: number,
  rule: {
    merchantPattern: string;
    matchKind: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  },
  source: string,
): void {
  scheduleInternalBackfill({
    householdId,
    ...ruleToBackfillScope(rule),
    source,
  });
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses an `effective_from` / `effective_to` body field.
 * Returns `{ ok: true, value }` for null, undefined, or a valid YYYY-MM-DD
 * string. Returns `{ ok: false, error }` otherwise.
 */
function parseEffectiveDate(
  raw: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !DATE_ONLY_RE.test(raw)) {
    return { ok: false, error: 'must be YYYY-MM-DD or null' };
  }
  // Round-trip through Date to reject calendar-invalid values like
  // 2026-13-01 or 2026-02-30 — the regex alone allows these because
  // SQLite stores DATEONLY as TEXT and won't reject them at insert.
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: 'must be a valid calendar date (YYYY-MM-DD)' };
  }
  return { ok: true, value: raw };
}

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rules = await Rule.findAll({
      where: householdWhere(req),
      order: [
        ['priority', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const out = [];
    for (const r of rules) {
      const usageCount = await Transaction.count({
        where: { appliedRuleId: r.id, ...visibleTransactionWhere(req) },
      });
      out.push({ ...r.toJSON(), usageCount });
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const { user, household } = currentAuth(req);
    if (!b.merchantPattern) {
      res.status(400).json({ error: 'merchantPattern is required' });
      return;
    }
    const fromParsed = parseEffectiveDate(b.effectiveFrom);
    if (!fromParsed.ok) {
      res.status(400).json({ error: `effectiveFrom ${fromParsed.error}` });
      return;
    }
    const toParsed = parseEffectiveDate(b.effectiveTo);
    if (!toParsed.ok) {
      res.status(400).json({ error: `effectiveTo ${toParsed.error}` });
      return;
    }
    if (
      fromParsed.value != null &&
      toParsed.value != null &&
      fromParsed.value >= toParsed.value
    ) {
      res.status(400).json({ error: 'effectiveFrom must be < effectiveTo' });
      return;
    }
    const row = await Rule.create({
      merchantPattern: String(b.merchantPattern),
      householdId: household.id,
      createdByUserId: user.id,
      matchKind: (b.matchKind as string) || 'substring',
      priority: b.priority != null ? Number(b.priority) : 0,
      category: (b.category as string | null) ?? null,
      isBusiness: Boolean(b.isBusiness),
      splitType: (b.splitType as string) || 'me',
      pctMe: b.pctMe != null ? String(b.pctMe) : null,
      pctPartner: b.pctPartner != null ? String(b.pctPartner) : null,
      effectiveFrom: fromParsed.value,
      effectiveTo: toParsed.value,
    });
    scheduleRuleBackfill(
      household.id,
      {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      },
      'rule-create',
    );
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.RuleCreated,
      entityType: AUDIT_ENTITY_TYPES.Rule,
      entityId: row.id,
      summary: `Created rule for "${row.merchantPattern}"`,
      after: {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        category: row.category,
        priority: row.priority,
        isBusiness: row.isBusiness,
        splitType: row.splitType,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      },
    });
    await recordFinanceEvent({
      req,
      type: FINANCE_EVENT_TYPES.RuleCreated,
      entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
      entityId: row.id,
      payload: {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        category: row.category,
        priority: row.priority,
        isBusiness: row.isBusiness,
        splitType: row.splitType,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      },
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

const RULE_AUDIT_FIELDS = [
  'merchantPattern',
  'matchKind',
  'priority',
  'category',
  'isBusiness',
  'splitType',
  'pctMe',
  'pctPartner',
  'effectiveFrom',
  'effectiveTo',
] as const;

function captureRuleAuditFields(
  row: InstanceType<typeof Rule>,
): Record<(typeof RULE_AUDIT_FIELDS)[number], unknown> {
  const out = {} as Record<(typeof RULE_AUDIT_FIELDS)[number], unknown>;
  for (const k of RULE_AUDIT_FIELDS) {
    out[k] = row.get(k);
  }
  return out;
}

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Rule.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Snapshot pre-edit shape so we can re-enrich anything the OLD pattern
    // matched, in addition to whatever the NEW pattern will match. Without
    // this, narrowing a rule (e.g. "AMAZON" → "AMAZON PRIME") would leave
    // formerly-matched txns stuck on the old categorisation.
    const previous = {
      merchantPattern: row.merchantPattern,
      matchKind: row.matchKind,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
    const auditPrev = captureRuleAuditFields(row);
    const b = (req.body || {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, 'effectiveFrom')) {
      const p = parseEffectiveDate(b.effectiveFrom);
      if (!p.ok) {
        res.status(400).json({ error: `effectiveFrom ${p.error}` });
        return;
      }
      row.set('effectiveFrom', p.value);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'effectiveTo')) {
      const p = parseEffectiveDate(b.effectiveTo);
      if (!p.ok) {
        res.status(400).json({ error: `effectiveTo ${p.error}` });
        return;
      }
      row.set('effectiveTo', p.value);
    }
    // Post-condition check using the post-set values:
    const newFrom = row.get('effectiveFrom') as string | null;
    const newTo = row.get('effectiveTo') as string | null;
    if (newFrom != null && newTo != null && newFrom >= newTo) {
      res.status(400).json({ error: 'effectiveFrom must be < effectiveTo' });
      return;
    }
    const fields = [
      'merchantPattern',
      'matchKind',
      'priority',
      'category',
      'isBusiness',
      'splitType',
      'pctMe',
      'pctPartner',
    ] as const;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(b, f)) row.set(f, b[f] as never);
    }
    await row.save();
    const { household } = currentAuth(req);
    scheduleRuleBackfill(household.id, previous, 'rule-update-prev');
    scheduleRuleBackfill(
      household.id,
      {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      },
      'rule-update-next',
    );
    const auditNext = captureRuleAuditFields(row);
    const diff = diffPatchableFields(auditPrev, auditNext, RULE_AUDIT_FIELDS);
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        req,
        action: AUDIT_ACTIONS.RuleUpdated,
        entityType: AUDIT_ENTITY_TYPES.Rule,
        entityId: row.id,
        summary: `Updated rule "${row.merchantPattern}": ${Object.keys(diff.after).slice(0, 3).join(', ')}`,
        before: diff.before,
        after: diff.after,
      });
      // Stream event includes the new field values only — replay-style
      // payload. Consumers can join earlier rule.created/rule.updated
      // events to reconstruct full history if needed.
      await recordFinanceEvent({
        req,
        type: FINANCE_EVENT_TYPES.RuleUpdated,
        entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
        entityId: row.id,
        payload: {
          changed: Object.keys(diff.after),
          after: diff.after,
        },
      });
    }
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/rules/auto-suggestions
 *
 * Issue #211 — surface behavioural pattern-based rule suggestions for the
 * household: cases where the user has manually categorised the same merchant
 * 3+ times in a consistent way, and there is no existing rule for it. Each
 * suggestion carries a confidence score and a human-readable reasoning
 * string so the user can decide whether to accept (create the rule) or
 * dismiss (suppress until evidence changes).
 *
 * Rate-limited because the suggestion query can be expensive on large
 * histories — CodeQL flags this as authorisation without rate limiting.
 */
router.get('/auto-suggestions', aiSuggestLimiter, async (req, res, next) => {
  try {
    const householdId = isSuperadmin(req) ? null : currentAuth(req).household.id;
    const suggestions = await findAutoRuleSuggestions(householdId);
    res.json({ suggestions });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/rules/health
 *
 * Returns aggregate rule-coverage metrics for the caller's household
 * (or all households if the caller is superadmin):
 *   - totalRules: number of rules
 *   - totalTransactions: number of transactions in the lookback window
 *   - hitCount / hitRate: # and fraction of in-window transactions whose
 *     applied_rule_id is non-null. Rate is 0 when totalTransactions is 0.
 *   - uncategorizedCount: in-window transactions with no final_category.
 *   - reviewFlagCount: in-window transactions whose review_flag is true.
 *   - staleRules: rules whose most-recent matched transaction is older
 *     than the lookback window (or has zero matches). Includes
 *     lastMatchedAt (ISO date) and matchCount.
 *   - duplicateRules: groups of >=2 rules sharing the same
 *     (merchantPattern lowercased, matchKind) within the same household.
 *   - topMerchantsWithoutRules: top merchant_canonical values (by count)
 *     for in-window transactions with applied_rule_id IS NULL and a
 *     non-empty merchant_canonical.
 *
 * Lookback window defaults to 90 days; clamped to [7, 365] via the
 * optional ?windowDays= query param.
 */
router.get('/health', async (req, res, next) => {
  try {
    const windowDaysRaw = Number(req.query.windowDays);
    const windowDays =
      Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
        ? Math.min(365, Math.max(7, Math.floor(windowDaysRaw)))
        : 90;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const sinceIso = since.toISOString().slice(0, 10);

    const householdId = isSuperadmin(req) ? null : currentAuth(req).household.id;
    // For aggregates we use household scope (not user-visibility) so the
    // counts match what the household sees on /rules, not just shared txns.
    const txnHouseholdWhere =
      householdId == null ? {} : { householdId };
    const ruleHouseholdWhere =
      householdId == null ? {} : { householdId };

    // The transaction aggregates are bounded by the date window so we don't
    // have to sweep history for every dashboard load.
    const inWindow = { date: { [Op.gte]: sinceIso } } as const;

    const [
      totalRules,
      totalTransactions,
      hitCount,
      uncategorizedCount,
      reviewFlagCount,
      lastMatches,
      duplicateRows,
      topMerchantRows,
    ] = await Promise.all([
      Rule.count({ where: ruleHouseholdWhere }),
      Transaction.count({ where: { ...txnHouseholdWhere, ...inWindow } }),
      Transaction.count({
        where: {
          ...txnHouseholdWhere,
          ...inWindow,
          appliedRuleId: { [Op.ne]: null },
        },
      }),
      Transaction.count({
        where: { ...txnHouseholdWhere, ...inWindow, finalCategory: null },
      }),
      Transaction.count({
        where: { ...txnHouseholdWhere, ...inWindow, reviewFlag: true },
      }),
      // Per-rule last-matched timestamp & match count. We use the txn date
      // (the user-meaningful "when did this rule last match a purchase?")
      // rather than created_at so a backfill doesn't artificially refresh
      // stale rules.
      sequelize.query<{
        ruleId: number;
        merchantPattern: string;
        matchKind: string;
        category: string | null;
        priority: number;
        createdAt: Date | string;
        lastMatchedAt: string | null;
        matchCount: string | number;
      }>(
        `SELECT r.id            AS "ruleId",
                r.merchant_pattern AS "merchantPattern",
                r.match_kind     AS "matchKind",
                r.category       AS category,
                r.priority       AS priority,
                r.created_at     AS "createdAt",
                MAX(t.date)      AS "lastMatchedAt",
                COUNT(t.id)      AS "matchCount"
           FROM rules r
           LEFT JOIN transactions t ON t.applied_rule_id = r.id
          ${householdId == null ? '' : 'WHERE r.household_id = :householdId'}
          GROUP BY r.id, r.merchant_pattern, r.match_kind, r.category,
                   r.priority, r.created_at
          ORDER BY r.id ASC`,
        {
          replacements: householdId == null ? {} : { householdId },
          type: QueryTypes.SELECT,
        },
      ),
      // Duplicates: same (LOWER(merchant_pattern), match_kind) in the same
      // household. We surface every such collision so the user can clean up.
      sequelize.query<{
        merchantPattern: string;
        matchKind: string;
        ruleIds: string;
      }>(
        `SELECT LOWER(r.merchant_pattern) AS "merchantPattern",
                r.match_kind              AS "matchKind",
                STRING_AGG(r.id::text, ',' ORDER BY r.id ASC) AS "ruleIds"
           FROM rules r
          ${householdId == null ? '' : 'WHERE r.household_id = :householdId'}
          GROUP BY LOWER(r.merchant_pattern), r.match_kind
                 ${householdId == null ? ', r.household_id' : ''}
         HAVING COUNT(*) > 1
          ORDER BY MIN(r.id) ASC`,
        {
          replacements: householdId == null ? {} : { householdId },
          type: QueryTypes.SELECT,
        },
      ),
      // Top merchants without rule coverage. We bound by the window for
      // signal freshness, require merchant_canonical (the post-enrichment
      // identity), exclude txns that already had a rule applied, and cap
      // at 15 rows.
      sequelize.query<{ merchantCanonical: string; count: string | number }>(
        `SELECT t.merchant_canonical AS "merchantCanonical",
                COUNT(*)            AS count
           FROM transactions t
          WHERE t.applied_rule_id IS NULL
            AND t.merchant_canonical IS NOT NULL
            AND TRIM(t.merchant_canonical) != ''
            AND t.date >= :sinceIso
            ${householdId == null ? '' : 'AND t.household_id = :householdId'}
          GROUP BY t.merchant_canonical
          ORDER BY COUNT(*) DESC, t.merchant_canonical ASC
          LIMIT 15`,
        {
          replacements:
            householdId == null ? { sinceIso } : { sinceIso, householdId },
          type: QueryTypes.SELECT,
        },
      ),
    ]);

    const staleRules = lastMatches
      .map((row) => {
        const lastMatchedAt =
          typeof row.lastMatchedAt === 'string'
            ? row.lastMatchedAt
            : row.lastMatchedAt == null
              ? null
              : new Date(row.lastMatchedAt).toISOString().slice(0, 10);
        return {
          id: Number(row.ruleId),
          merchantPattern: row.merchantPattern,
          matchKind: row.matchKind,
          category: row.category,
          priority: Number(row.priority),
          createdAt:
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : String(row.createdAt),
          lastMatchedAt,
          matchCount: Number(row.matchCount) || 0,
        };
      })
      .filter((r) => r.lastMatchedAt == null || r.lastMatchedAt < sinceIso);

    const duplicateRules = duplicateRows.map((row) => ({
      merchantPattern: row.merchantPattern,
      matchKind: row.matchKind,
      ruleIds: String(row.ruleIds || '')
        .split(',')
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id)),
    }));

    const topMerchantsWithoutRules = topMerchantRows.map((row) => ({
      merchantCanonical: row.merchantCanonical,
      count: Number(row.count) || 0,
    }));

    res.json({
      windowDays,
      totalRules,
      totalTransactions,
      hitCount,
      hitRate: totalTransactions === 0 ? 0 : hitCount / totalTransactions,
      uncategorizedCount,
      reviewFlagCount,
      staleRules,
      duplicateRules,
      topMerchantsWithoutRules,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/rules/suggestions
 *
 * Thin wrapper around `findRuleProposals` so the URL contract from issue
 * #206 is satisfied without forking the existing rule-proposal logic.
 * Returns `{ suggestions: RuleProposal[] }`. The frontend reuses the
 * existing POST /api/ai/rule-proposals/:merchantPattern/approve flow to
 * turn a suggestion into a real rule.
 */
router.get('/suggestions', async (req, res, next) => {
  try {
    const suggestions = await findRuleProposals(
      isSuperadmin(req) ? null : currentAuth(req).household.id,
    );
    res.json({ suggestions });
  } catch (e) {
    next(e);
  }
});

/**
 * Look up the (current) auto-rule suggestion the caller refers to by `:id`.
 * Suggestions are derived (not stored), so this re-queries and matches the
 * stable hash. Returns null if the suggestion is no longer surfaced — caller
 * should respond with 404.
 */
async function findAutoSuggestionById(
  householdId: number | null,
  id: string,
): Promise<AutoRuleSuggestion | null> {
  const all = await findAutoRuleSuggestions(householdId);
  return all.find((s) => s.id === id) ?? null;
}

router.post('/auto-suggestions/:id/accept', aiSuggestLimiter, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const id = req.params.id;
    const suggestion = await findAutoSuggestionById(
      isSuperadmin(req) ? null : household.id,
      id,
    );
    if (!suggestion) {
      res.status(404).json({ error: 'Auto-rule suggestion not found' });
      return;
    }
    const row = await Rule.create({
      merchantPattern: suggestion.merchantPattern,
      householdId: household.id,
      createdByUserId: user.id,
      matchKind: 'substring',
      priority: 0,
      category: suggestion.category,
      isBusiness: suggestion.isBusiness,
      splitType: suggestion.splitType,
      pctMe: suggestion.pctMe,
      pctPartner: suggestion.pctPartner,
    });
    scheduleRuleBackfill(
      household.id,
      {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      },
      'rule-auto-suggestion-accept',
    );
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.AiSuggestionAccepted,
      entityType: AUDIT_ENTITY_TYPES.Rule,
      entityId: row.id,
      summary: `Accepted auto-suggestion: rule for "${row.merchantPattern}"`,
      after: {
        merchantPattern: row.merchantPattern,
        matchKind: row.matchKind,
        category: row.category,
        isBusiness: row.isBusiness,
        splitType: row.splitType,
      },
      metadata: {
        suggestionId: suggestion.id,
        confidence: suggestion.confidence,
      },
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.post('/auto-suggestions/:id/dismiss', aiSuggestLimiter, async (req, res, next) => {
  try {
    const id = req.params.id;
    const suggestion = await findAutoSuggestionById(
      isSuperadmin(req) ? null : currentAuth(req).household.id,
      id,
    );
    if (!suggestion) {
      res.status(404).json({ error: 'Auto-rule suggestion not found' });
      return;
    }
    const merchantPattern = merchantPatternFor(suggestion.merchantPattern);
    if (!merchantPattern) {
      res.status(400).json({ error: 'merchantPattern is required' });
      return;
    }
    await createTrackedSuggestion({
      req,
      kind: 'rule_proposal',
      inputSnapshot: { merchantPattern },
      output: null,
      status: 'rejected',
      model: 'deterministic',
      promptVersion: 'rule-auto-suggestion-dismiss-v1',
    });
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.AiSuggestionDismissed,
      entityType: AUDIT_ENTITY_TYPES.Rule,
      entityId: null,
      summary: `Dismissed auto-suggestion for "${merchantPattern}"`,
      metadata: {
        suggestionId: suggestion.id,
        merchantPattern,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/rules/preview-pattern
 *
 * Issue #261 — validate a regex pattern and count how many of the household's
 * transactions the pattern would match. Used by the frontend to show a live
 * "matches N existing transactions" indicator and to surface invalid regex
 * errors inline before the user saves a rule.
 *
 * Body: { pattern: string, matchType: 'substring' | 'regex' }
 * Response:
 *   200 { matches: number, sample: Transaction[] }
 *       `matches` is capped at 500; if the true count exceeds 500 the value
 *       will be exactly 500 and the frontend should display "500+".
 *   400 { error: 'INVALID_PATTERN', message: string }  (regex only)
 */
router.post('/preview-pattern', async (req, res, next) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const pattern = typeof b.pattern === 'string' ? b.pattern : '';
    const matchType =
      b.matchType === 'regex' || b.matchType === 'substring' ? b.matchType : 'substring';

    // For regex, attempt to compile first — return 400 on failure.
    let re: RegExp | null = null;
    if (matchType === 'regex') {
      try {
        re = new RegExp(pattern, 'i');
      } catch (err) {
        res.status(400).json({
          error: 'INVALID_PATTERN',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    const { household } = currentAuth(req);

    // Fetch all transactions for the household (unbounded — typical households
    // have < 10 k rows; we stop as soon as we have 501 matches).
    const allTxns = await Transaction.findAll({
      where: { householdId: household.id },
      attributes: ['id', 'merchantClean', 'merchantRaw', 'date', 'amount', 'finalCategory'],
      order: [['date', 'DESC']],
    });

    const CAP = 500;
    const sample: (typeof allTxns)[number][] = [];
    let matchCount = 0;
    for (const txn of allTxns) {
      const haystack = (txn.get('merchantClean') as string | null) || '';
      let matched = false;
      if (matchType === 'regex' && re) {
        matched = re.test(haystack);
      } else {
        matched = haystack.toLowerCase().includes(pattern.toLowerCase());
      }
      if (matched) {
        matchCount++;
        if (sample.length < 5) sample.push(txn);
        if (matchCount > CAP) break;
      }
    }

    res.json({
      matches: Math.min(matchCount, CAP),
      sample: sample.map((t) => t.toJSON()),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Rule.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const snapshot = {
      merchantPattern: row.merchantPattern,
      matchKind: row.matchKind,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
    const auditSnapshot = captureRuleAuditFields(row);
    const ruleId = row.id;
    const { household } = currentAuth(req);
    await row.destroy();
    scheduleRuleBackfill(household.id, snapshot, 'rule-delete');
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.RuleDeleted,
      entityType: AUDIT_ENTITY_TYPES.Rule,
      entityId: ruleId,
      summary: `Deleted rule "${snapshot.merchantPattern}"`,
      before: auditSnapshot,
    });
    await recordFinanceEvent({
      req,
      type: FINANCE_EVENT_TYPES.RuleDeleted,
      entityType: FINANCE_EVENT_ENTITY_TYPES.Rule,
      entityId: ruleId,
      payload: auditSnapshot,
    });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
