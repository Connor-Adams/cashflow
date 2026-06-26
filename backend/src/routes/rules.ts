import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import crypto from 'crypto';
import { Rule, Transaction, Label, sequelize } from '../models';
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
import {
  validateActions,
  deriveActionsFromScalars,
  deriveScalarsFromActions,
  type RuleAction,
} from '../rules/actions';
import { validateUserPattern, safeRegexTest } from '../util/safeRegex';

/**
 * Issue #818: reject an unsafe user regex at rule-creation/update time so a
 * catastrophic-backtracking pattern is never persisted (and then re-run on every
 * import). Only applies when matchKind is 'regex'; substring/exact are inert.
 * Returns null when OK, or a typed error for the route to surface as a 400.
 */
function checkRulePattern(
  matchKind: unknown,
  merchantPattern: unknown,
): { error: string; message: string } | null {
  if (matchKind !== 'regex') return null;
  const v = validateUserPattern(String(merchantPattern ?? ''), 'i');
  return v.ok ? null : { error: v.error, message: v.message };
}

/**
 * Resolve the household's Label id set for `set_label` validation. Returns null
 * for a superadmin with no household scope (skips the scope check).
 */
async function householdLabelIds(householdId: number): Promise<Set<number>> {
  const labels = await Label.findAll({ where: { householdId }, attributes: ['id'] });
  return new Set(labels.map((l) => l.id));
}

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

const RULES_SORT_FIELDS = ['name', 'matchType', 'priority', 'updatedAt'] as const;
type RulesSortField = typeof RULES_SORT_FIELDS[number];
const RULES_SORT_COLUMN_MAP: Record<RulesSortField, string> = {
  name: 'merchantPattern',
  matchType: 'matchKind',
  priority: 'priority',
  updatedAt: 'updatedAt',
};

router.get('/', async (req, res, next) => {
  try {
    const sortParam = req.query.sort as string | undefined;
    const dirParam = req.query.dir as string | undefined;

    if (sortParam !== undefined && !RULES_SORT_FIELDS.includes(sortParam as RulesSortField)) {
      res.status(400).json({ error: 'INVALID_SORT_FIELD' });
      return;
    }
    if (dirParam !== undefined && dirParam !== 'asc' && dirParam !== 'desc') {
      res.status(400).json({ error: 'INVALID_SORT_FIELD' });
      return;
    }

    const sortField = sortParam as RulesSortField | undefined;
    const dir = (dirParam ?? 'desc') as 'asc' | 'desc';
    const order: [string, string][] = sortField
      ? [[RULES_SORT_COLUMN_MAP[sortField], dir.toUpperCase()]]
      : [['priority', 'DESC'], ['id', 'DESC']];

    const rules = await Rule.findAll({
      where: householdWhere(req),
      order: order as [string, string][],
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
    const patternErr = checkRulePattern((b.matchKind as string) || 'substring', b.merchantPattern);
    if (patternErr) {
      res.status(400).json(patternErr);
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

    // Issue #795: when `actions[]` is present, validate it and DERIVE the
    // scalar columns from the set_category/business/split actions. When absent
    // (legacy client), build actions from the scalar body. Either way the
    // scalar columns and the actions array are persisted in sync.
    let actions: RuleAction[];
    let scalar: ReturnType<typeof deriveScalarsFromActions>;
    if (Object.prototype.hasOwnProperty.call(b, 'actions')) {
      const validated = validateActions(b.actions, await householdLabelIds(household.id));
      if (!validated.ok) {
        res.status(400).json({ error: validated.error, message: validated.message, index: validated.index });
        return;
      }
      actions = validated.actions;
      scalar = deriveScalarsFromActions(actions);
    } else {
      scalar = {
        category: (b.category as string | null) ?? null,
        isBusiness: Boolean(b.isBusiness),
        splitType: (b.splitType as string) || 'me',
        pctMe: b.pctMe != null ? String(b.pctMe) : null,
        pctPartner: b.pctPartner != null ? String(b.pctPartner) : null,
      };
      actions = deriveActionsFromScalars(scalar);
    }

    const row = await Rule.create({
      merchantPattern: String(b.merchantPattern),
      householdId: household.id,
      createdByUserId: user.id,
      matchKind: (b.matchKind as string) || 'substring',
      priority: b.priority != null ? Number(b.priority) : 0,
      category: scalar.category,
      isBusiness: scalar.isBusiness,
      splitType: scalar.splitType,
      pctMe: scalar.pctMe,
      pctPartner: scalar.pctPartner,
      effectiveFrom: fromParsed.value,
      effectiveTo: toParsed.value,
      actions,
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
    // Always-patchable identity/match fields.
    const fields = ['merchantPattern', 'matchKind', 'priority'] as const;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(b, f)) row.set(f, b[f] as never);
    }
    // Issue #818: validate the resulting (post-merge) pattern so an edit can't
    // turn a safe rule into a ReDoS one, even if only one of pattern/matchKind
    // is supplied in the body.
    const patternErr = checkRulePattern(row.get('matchKind'), row.get('merchantPattern'));
    if (patternErr) {
      res.status(400).json(patternErr);
      return;
    }

    // Issue #795 effect sync. If `actions[]` is present it is authoritative:
    // validate it, derive the scalar columns from it. Otherwise apply any
    // scalar fields in the body, then re-derive the actions array from the
    // resulting scalars so the two never drift.
    if (Object.prototype.hasOwnProperty.call(b, 'actions')) {
      const { household } = currentAuth(req);
      const validated = validateActions(b.actions, await householdLabelIds(household.id));
      if (!validated.ok) {
        res.status(400).json({ error: validated.error, message: validated.message, index: validated.index });
        return;
      }
      const scalar = deriveScalarsFromActions(validated.actions);
      row.set('category', scalar.category);
      row.set('isBusiness', scalar.isBusiness);
      row.set('splitType', scalar.splitType);
      row.set('pctMe', scalar.pctMe);
      row.set('pctPartner', scalar.pctPartner);
      row.set('actions', validated.actions);
    } else {
      const scalarFields = ['category', 'isBusiness', 'splitType', 'pctMe', 'pctPartner'] as const;
      for (const f of scalarFields) {
        if (Object.prototype.hasOwnProperty.call(b, f)) row.set(f, b[f] as never);
      }
      const scalar = {
        category: (row.get('category') as string | null) ?? null,
        isBusiness: Boolean(row.get('isBusiness')),
        splitType: (row.get('splitType') as string) || 'me',
        pctMe: row.get('pctMe') != null ? String(row.get('pctMe')) : null,
        pctPartner: row.get('pctPartner') != null ? String(row.get('pctPartner')) : null,
      };
      // Preserve any non-scalar (set_label / set_alert) actions already on the
      // rule; only re-derive the scalar-backed action triplet.
      const existing = (row.get('actions') as RuleAction[] | null) ?? [];
      const nonScalar = existing.filter(
        (a) => a.type === 'set_label' || a.type === 'set_alert',
      );
      row.set('actions', [...deriveActionsFromScalars(scalar), ...nonScalar]);
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

const EXPORT_SCHEMA_VERSION = 1;

type ExportedRule = {
  merchantPattern: string;
  matchKind: string;
  priority: number;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /**
   * Issue #795: the composable actions list. Additive to the v1 schema — older
   * importers whitelist the fields they read and ignore this key, so the file
   * still round-trips on pre-#795 instances using the scalar fields alone.
   */
  actions: RuleAction[];
};

router.get('/export', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rules = await Rule.findAll({
      where: householdWhere(req),
      order: [['priority', 'DESC'], ['id', 'DESC']],
    });
    const exportedRules: ExportedRule[] = rules.map((r) => ({
      merchantPattern: r.merchantPattern,
      matchKind: r.matchKind,
      priority: r.priority,
      category: r.category,
      isBusiness: r.isBusiness,
      splitType: r.splitType,
      pctMe: r.pctMe != null ? String(r.pctMe) : null,
      pctPartner: r.pctPartner != null ? String(r.pctPartner) : null,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      // Fall back to deriving from scalars for any row that predates the column
      // backfill (defensive — the migration backfills every row).
      actions:
        Array.isArray(r.actions) && r.actions.length > 0
          ? r.actions
          : deriveActionsFromScalars({
              category: r.category,
              isBusiness: r.isBusiness,
              splitType: r.splitType,
              pctMe: r.pctMe != null ? String(r.pctMe) : null,
              pctPartner: r.pctPartner != null ? String(r.pctPartner) : null,
            }),
    }));
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cashflow-rules-${today}.json"`);
    res.json({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 16),
      rules: exportedRules,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/import', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body || {}) as Record<string, unknown>;

    const mode = body.mode;
    if (mode !== 'append' && mode !== 'replace') {
      res.status(400).json({ error: 'INVALID_MODE', message: "mode must be 'append' or 'replace'" });
      return;
    }

    const json = body.json as Record<string, unknown> | undefined;
    if (!json || typeof json !== 'object') {
      res.status(400).json({ error: 'INVALID_JSON', message: "json is required" });
      return;
    }
    if (json.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      if (typeof json.schemaVersion === 'number' && json.schemaVersion > EXPORT_SCHEMA_VERSION) {
        res.status(400).json({ error: 'UNSUPPORTED_VERSION', message: 'This file is from a newer version of Cashflow.' });
      } else {
        res.status(400).json({ error: 'UNSUPPORTED_VERSION', message: 'Invalid or unsupported schemaVersion.' });
      }
      return;
    }

    const rawRules = Array.isArray(json.rules) ? json.rules as unknown[] : [];
    const today = new Date().toISOString().slice(0, 10);

    const validated: ExportedRule[] = [];
    const errors: { name: string; reason: string }[] = [];
    // Household label scope for any `set_label` actions in the file.
    const labelIds = await householdLabelIds(household.id);

    for (const r of rawRules) {
      if (!r || typeof r !== 'object') {
        errors.push({ name: '(unknown)', reason: 'not an object' });
        continue;
      }
      const rule = r as Record<string, unknown>;
      if (!rule.merchantPattern || typeof rule.merchantPattern !== 'string') {
        errors.push({ name: String(rule.merchantPattern ?? '(unknown)'), reason: 'merchantPattern is required' });
        continue;
      }
      const importMatchKind = typeof rule.matchKind === 'string' ? rule.matchKind : 'substring';
      const patternErr = checkRulePattern(importMatchKind, rule.merchantPattern);
      if (patternErr) {
        errors.push({ name: rule.merchantPattern, reason: patternErr.message });
        continue;
      }
      const fromParsed = parseEffectiveDate(rule.effectiveFrom ?? null);
      if (!fromParsed.ok) {
        errors.push({ name: rule.merchantPattern, reason: `effectiveFrom ${fromParsed.error}` });
        continue;
      }
      const toParsed = parseEffectiveDate(rule.effectiveTo ?? null);
      if (!toParsed.ok) {
        errors.push({ name: rule.merchantPattern, reason: `effectiveTo ${toParsed.error}` });
        continue;
      }

      const scalar = {
        category: typeof rule.category === 'string' ? rule.category : null,
        isBusiness: Boolean(rule.isBusiness),
        splitType: typeof rule.splitType === 'string' ? rule.splitType : 'me',
        pctMe: rule.pctMe != null ? String(rule.pctMe) : null,
        pctPartner: rule.pctPartner != null ? String(rule.pctPartner) : null,
      };

      // Issue #795: when the imported rule carries `actions`, validate and use
      // them, deriving the scalar columns from the action triplet so they stay
      // in sync. When it doesn't (a pre-#795 v1 file), derive `actions` from the
      // scalar fields exactly as the migration does — so an old export imports
      // identically to today.
      let actions: RuleAction[];
      if (Object.prototype.hasOwnProperty.call(rule, 'actions')) {
        const v = validateActions(rule.actions, labelIds);
        if (!v.ok) {
          errors.push({ name: rule.merchantPattern, reason: `actions ${v.message}` });
          continue;
        }
        actions = v.actions;
        const derived = deriveScalarsFromActions(actions);
        scalar.category = derived.category;
        scalar.isBusiness = derived.isBusiness;
        scalar.splitType = derived.splitType;
        scalar.pctMe = derived.pctMe;
        scalar.pctPartner = derived.pctPartner;
      } else {
        actions = deriveActionsFromScalars(scalar);
      }

      validated.push({
        merchantPattern: rule.merchantPattern,
        matchKind: importMatchKind,
        priority: typeof rule.priority === 'number' ? rule.priority : 0,
        category: scalar.category,
        isBusiness: scalar.isBusiness,
        splitType: scalar.splitType,
        pctMe: scalar.pctMe,
        pctPartner: scalar.pctPartner,
        effectiveFrom: fromParsed.value,
        effectiveTo: toParsed.value,
        actions,
      });
    }

    let imported = 0;

    await sequelize.transaction(async (t) => {
      if (mode === 'replace') {
        await Rule.destroy({ where: { householdId: household.id }, transaction: t });
      }

      const existingPatterns = mode === 'append'
        ? new Set((await Rule.findAll({ where: { householdId: household.id }, attributes: ['merchantPattern'], transaction: t })).map((r) => r.merchantPattern))
        : new Set<string>();

      for (const rule of validated) {
        let name = rule.merchantPattern;
        if (mode === 'append' && existingPatterns.has(name)) {
          name = `${name} (imported ${today})`;
        }
        await Rule.create({
          merchantPattern: name,
          householdId: household.id,
          createdByUserId: user.id,
          matchKind: rule.matchKind,
          priority: rule.priority,
          category: rule.category,
          isBusiness: rule.isBusiness,
          splitType: rule.splitType,
          pctMe: rule.pctMe,
          pctPartner: rule.pctPartner,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo,
          actions: rule.actions,
        }, { transaction: t });
        imported++;
      }
    });

    res.json({ imported, skipped: errors.length, errors });
  } catch (e) {
    next(e);
  }
});

// POST /api/rules/preview-pattern — count matching transactions for a pattern.
// Returns { matches, sample } (matches capped at 500).
router.post('/preview-pattern', async (req, res, next) => {
  try {
    const { pattern, matchType } = (req.body ?? {}) as { pattern?: unknown; matchType?: unknown };
    const patternStr = pattern != null ? String(pattern) : '';
    const kindStr = matchType != null ? String(matchType) : 'substring';

    // Issue #818: validate the user regex ONCE up front (length bound + ReDoS
    // structural rejection + compile). Reuse the single compiled RegExp for all
    // rows instead of recompiling per transaction.
    let compiledRe: RegExp | null = null;
    if (kindStr === 'regex') {
      const v = validateUserPattern(patternStr, 'i');
      if (!v.ok) {
        res.status(400).json({ error: v.error, message: v.message });
        return;
      }
      compiledRe = v.re;
    }

    const where = {
      ...householdWhere(req),
      ...visibleTransactionWhere(req),
    };

    const allTxns = await Transaction.findAll({
      where,
      attributes: ['id', 'merchantClean', 'merchantRaw', 'date', 'amount', 'currency', 'finalCategory'],
      order: [['date', 'DESC']],
      limit: 2000,
      raw: true,
    });

    type Row = { id: number; merchantClean: string | null; merchantRaw: string | null; date: string; amount: string | number; currency: string; finalCategory: string | null };

    let matches = 0;
    const sample: Row[] = [];
    for (const t of allTxns as unknown as Row[]) {
      const merchant = (t.merchantClean || t.merchantRaw || '').toLowerCase();
      let ok = false;
      if (kindStr === 'regex') {
        ok = compiledRe != null && safeRegexTest(compiledRe, merchant);
      } else {
        ok = merchant.includes(patternStr.toLowerCase());
      }
      if (ok) {
        matches++;
        if (sample.length < 5) sample.push(t);
        if (matches >= 500) break;
      }
    }

    res.json({ matches, sample });
  } catch (e) {
    next(e);
  }
});

export default router;
