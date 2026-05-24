import { Router } from 'express';
import { Rule, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere, visibleTransactionWhere } from '../auth/scope';

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
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Rule.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
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
    res.json(row);
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
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
