// backend/src/routes/tax-personal-scenarios.ts
//
// CRUD routes for the personal tax scenario tree (P7 Task 6). Fork / compute /
// compare endpoints land in P7 Task 7.
//
// All endpoints are mounted under `/api/tax/personal-scenarios` and require
// auth (the global `requireAuth` middleware at `/api` enforces this).
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';
import { validateOverrideMap } from '../tax/scenarios/overrideKeys';
import { ensureBaselineScenario } from '../tax/scenarios/resolveScenario';
import { computeScenario } from '../tax/scenarios/computeScenario';

const router = Router();

// Helper: resolve scenario ID + ensure the caller's household owns the
// underlying entity. Returns either the loaded scenario+entity or an `error`
// discriminator the caller maps to an HTTP status.
async function loadAndAuthorize(req: import('express').Request, scenarioId: number) {
  const { household } = currentAuth(req);
  if (!Number.isInteger(scenarioId)) return { error: 'not_found' as const };
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) return { error: 'not_found' as const };
  const entity = await Entity.findByPk(scenario.entityId);
  if (!entity || entity.householdId !== household.id) {
    return { error: 'forbidden' as const };
  }
  return { scenario, entity };
}

// POST /api/tax/personal-scenarios — create a fork scenario.
// Baseline is auto-created if not yet present for (entityId, year). New
// scenario's parent defaults to the baseline unless `parentId` is supplied.
router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const {
      entityId,
      year,
      name,
      overrides = {},
      assumptions = {},
      parentId = null,
      notes = null,
    } = req.body ?? {};

    if (
      !Number.isInteger(entityId) ||
      !Number.isInteger(year) ||
      typeof name !== 'string' ||
      name.trim() === ''
    ) {
      res.status(400).json({
        error: 'invalid_body',
        message: 'entityId (int), year (int), name (non-empty string) required',
      });
      return;
    }

    const entity = await Entity.findByPk(entityId);
    if (!entity || entity.householdId !== household.id) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }

    try {
      validateOverrideMap(overrides, 'personal');
    } catch (err) {
      res
        .status(400)
        .json({ error: 'invalid_overrides', message: (err as Error).message });
      return;
    }

    // Auto-create the baseline so explicit forks always have a stable root.
    const baseline = await ensureBaselineScenario(entityId, year);
    const effectiveParentId = parentId ?? baseline.id;

    const scenario = await Scenario.create({
      parentId: effectiveParentId,
      householdPlanId: null,
      entityId,
      year,
      name,
      kind: 'fork',
      overrides,
      assumptions,
      nextYearId: null,
      notes,
    });
    res.status(201).json({ scenario });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal-scenarios?entityId=&year= — list scenarios for an
// entity+year, ordered by creation time so the baseline (created first via
// auto-create) renders before forks.
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.query.entityId);
    const year = Number(req.query.year);
    if (!Number.isInteger(entityId) || !Number.isInteger(year)) {
      res.status(400).json({
        error: 'invalid_query',
        message: 'entityId and year query params required',
      });
      return;
    }
    const entity = await Entity.findByPk(entityId);
    if (!entity || entity.householdId !== household.id) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    const scenarios = await Scenario.findAll({
      where: { entityId, year },
      order: [['createdAt', 'ASC']],
    });
    res.json({ scenarios });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal-scenarios/compare?ids=1,2,3 — diff payload for N
// scenarios. MUST be registered before `GET /:id` so Express doesn't match
// the literal "compare" as the `:id` param.
router.get('/compare', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const idsRaw = String(req.query.ids ?? '');
    const ids = idsRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      res.status(400).json({
        error: 'invalid_query',
        message: 'ids query param required (comma-separated)',
      });
      return;
    }
    const scenarios = await Scenario.findAll({ where: { id: ids } });
    if (scenarios.length !== ids.length) {
      res.status(404).json({ error: 'scenario_not_found' });
      return;
    }
    // Authorize: every referenced scenario's entity must live in the caller's
    // household. One mismatched entity nukes the whole request (403) so a
    // partial-permission compare can't leak any rows.
    const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
    const entities = await Entity.findAll({ where: { id: entityIds } });
    if (entities.some((e) => e.householdId !== household.id)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const computedAll = await Promise.all(
      scenarios.map(async (s) => ({
        scenario: s,
        computed: await computeScenario(s.id),
      })),
    );
    res.json({ scenarios: computedAll });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal-scenarios/:id — get a scenario + its computed return
// (cached on facts hash; recomputed on miss).
router.get('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const computed = await computeScenario(result.scenario.id);
    res.json({ scenario: result.scenario, computed });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tax/personal-scenarios/:id — update name / notes / overrides /
// assumptions. Overrides go through the same validator the POST handler uses.
router.patch('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const updates: Partial<{
      name: string;
      notes: string | null;
      overrides: Record<string, unknown>;
      assumptions: Record<string, unknown>;
    }> = {};
    if ('name' in req.body) updates.name = String(req.body.name);
    if ('notes' in req.body) {
      updates.notes = req.body.notes === null ? null : String(req.body.notes);
    }
    if ('overrides' in req.body) {
      try {
        validateOverrideMap(req.body.overrides, 'personal');
      } catch (err) {
        res
          .status(400)
          .json({ error: 'invalid_overrides', message: (err as Error).message });
        return;
      }
      updates.overrides = req.body.overrides;
    }
    if ('assumptions' in req.body) updates.assumptions = req.body.assumptions;
    await result.scenario.update(updates);
    res.json({ scenario: result.scenario });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tax/personal-scenarios/:id — delete a fork. Refuses baselines
// (the baseline is the engine's anchor for actuals) and any node that still
// has children (the foreign key uses RESTRICT, but checking here gives a clear
// 409 rather than an opaque DB error).
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    if (result.scenario.kind === 'baseline') {
      res.status(409).json({ error: 'baseline_cannot_be_deleted' });
      return;
    }
    const childCount = await Scenario.count({ where: { parentId: result.scenario.id } });
    if (childCount > 0) {
      res.status(409).json({
        error: 'has_children',
        message: `Cannot delete scenario with ${childCount} descendant(s).`,
      });
      return;
    }
    await result.scenario.destroy();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal-scenarios/:id/fork — create a child scenario whose
// effective facts inherit from the parent via ancestry resolution. The new
// scenario starts with an empty override map; inheritance is by walking the
// parent chain at compute time, not by duplicating overrides.
router.post('/:id/fork', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim() !== ''
        ? req.body.name
        : `${result.scenario.name} (fork)`;
    const child = await Scenario.create({
      parentId: result.scenario.id,
      householdPlanId: result.scenario.householdPlanId,
      entityId: result.scenario.entityId,
      year: result.scenario.year,
      name,
      kind: 'fork',
      overrides: {},
      assumptions: {},
      nextYearId: null,
      notes: null,
    });
    res.status(201).json({ scenario: child });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal-scenarios/:id/project-next-year — create a
// projection_root scenario for year+1 chained to `:id` via `next_year_id`.
// Idempotent: if a projection_root already exists for the same entity+next
// year, returns 409 with the existing scenario so callers can recover the
// link without creating a duplicate.
router.post('/:id/project-next-year', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    if (result.scenario.kind === 'projection_root') {
      // Block chaining two projection_root scenarios in a single hop — the
      // resolver requires a baseline (or fork) as the year-N anchor.
      res.status(400).json({
        error: 'already_projection_root',
        message:
          'Cannot project from a projection_root scenario; project from a baseline or fork.',
      });
      return;
    }
    const nextYear = result.scenario.year + 1;
    const existing = await Scenario.findOne({
      where: {
        entityId: result.scenario.entityId,
        year: nextYear,
        kind: 'projection_root',
      },
    });
    if (existing) {
      res.status(409).json({
        error: 'projection_already_exists',
        message: `A projection_root scenario already exists for entity ${result.scenario.entityId} year ${nextYear}.`,
        scenario: existing,
      });
      return;
    }
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim() !== ''
        ? req.body.name
        : `Projection ${nextYear}`;
    const assumptions =
      req.body?.assumptions && typeof req.body.assumptions === 'object'
        ? req.body.assumptions
        : {};
    const projection = await Scenario.create({
      parentId: result.scenario.id,
      householdPlanId: result.scenario.householdPlanId,
      entityId: result.scenario.entityId,
      year: nextYear,
      name,
      kind: 'projection_root',
      overrides: {},
      assumptions,
      nextYearId: null,
      notes: null,
    });
    // Link the chain forward: parent.nextYearId now points at the new
    // projection so GET /:id/chain (Task 5) can walk year N → N+1.
    await result.scenario.update({ nextYearId: projection.id });
    res.status(201).json({ scenario: projection });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal-scenarios/:id/compute — force a recompute, bypassing
// the facts-hash cache. Always writes a fresh ScenarioReturn row.
router.post('/:id/compute', async (req, res, next) => {
  try {
    const result = await loadAndAuthorize(req, Number(req.params.id));
    if ('error' in result) {
      res.status(result.error === 'not_found' ? 404 : 403).json({ error: result.error });
      return;
    }
    const computed = await computeScenario(result.scenario.id, { force: true });
    res.json({ computed });
  } catch (err) {
    next(err);
  }
});

export default router;
