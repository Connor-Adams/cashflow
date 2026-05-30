// backend/src/routes/tax-scenarios.ts
//
// Unified CRUD + fork/compute/compare/chain routes for tax scenarios
// (issue #377). Folds the former tax-personal-scenarios.ts + tax-corp-scenarios.ts
// into one router mounted at `/api/tax/scenarios`.
//
// The first path segment is `:kind` ∈ {personal, corp}. A `requireKind`
// middleware validates it and stashes the matching `SCENARIO_KIND_CONFIG` entry
// on `res.locals.scenarioKind`; every handler then dispatches through that
// config (override validator, baseline-ensure fn, compute fn, entity-kind
// guard) instead of branching on the kind. The personal/corp routes were
// byte-for-byte identical apart from those four axes, so there is a single
// handler per endpoint — no parallel mirrored implementations.
//
// All endpoints require auth (the global `requireAuth` middleware at `/api`).
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';
import {
  SCENARIO_KIND_CONFIG,
  isScenarioEntityKind,
  withAuthorizedScenario,
  type ScenarioKindConfig,
  type ScenarioRouteHandler,
} from './tax-scenario-routing';

const router = Router();

/**
 * Validate the `:kind` path segment and stash the resolved per-kind config on
 * `res.locals.scenarioKind`. Unknown kinds short-circuit with 404 so a typo'd
 * path can't silently fall through to the corp (or personal) handler.
 */
const requireKind: RequestHandler = (req, res, next) => {
  const { kind } = req.params;
  if (!isScenarioEntityKind(kind)) {
    res.status(404).json({
      error: 'unknown_scenario_kind',
      message: `kind must be 'personal' or 'corp', got '${kind}'`,
    });
    return;
  }
  res.locals.scenarioKind = SCENARIO_KIND_CONFIG[kind];
  next();
};

function cfgOf(res: Response): ScenarioKindConfig {
  return res.locals.scenarioKind as ScenarioKindConfig;
}

// `withAuthorizedScenario` needs the per-kind guard, which is only known at
// request time (it lives in res.locals). This thin wrapper reads the resolved
// config and forwards the guard so `:id` endpoints reject the wrong entity kind
// exactly as the old corp route did (personal stays lax via `undefined`).
function withScenario(handler: ScenarioRouteHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const cfg = cfgOf(res);
    return withAuthorizedScenario(cfg.entityKindGuard, handler)(req, res, next);
  };
}

// All routes carry the `:kind` segment; validate it before anything else.
router.use('/:kind', requireKind);

// POST /api/tax/scenarios/:kind — create a fork scenario.
// Baseline is auto-created if not yet present for (entityId, year). New
// scenario's parent defaults to the baseline unless `parentId` is supplied.
router.post('/:kind', async (req, res, next) => {
  try {
    const cfg = cfgOf(res);
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
    // Corp enforces entity kind; personal stays lax (guard is undefined).
    if (cfg.entityKindGuard !== undefined && entity.kind !== cfg.entityKindGuard) {
      res.status(400).json({
        error: `not_${cfg.entityKindGuard}`,
        message: `entity id=${entityId} is kind=${entity.kind}, not ${cfg.entityKindGuard}`,
      });
      return;
    }

    try {
      cfg.validateOverrides(overrides);
    } catch (err) {
      res
        .status(400)
        .json({ error: 'invalid_overrides', message: (err as Error).message });
      return;
    }

    // Auto-create the baseline so explicit forks always have a stable root.
    const baseline = await cfg.ensureBaseline(entityId, year);
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

// GET /api/tax/scenarios/:kind?entityId=&year= — list scenarios for an
// entity+year, ordered by creation time so the baseline (created first via
// auto-create) renders before forks.
router.get('/:kind', async (req, res, next) => {
  try {
    const cfg = cfgOf(res);
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
    if (cfg.entityKindGuard !== undefined && entity.kind !== cfg.entityKindGuard) {
      res.status(400).json({
        error: `not_${cfg.entityKindGuard}`,
        message: `entity id=${entityId} is kind=${entity.kind}, not ${cfg.entityKindGuard}`,
      });
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

// GET /api/tax/scenarios/:kind/compare?ids=1,2,3 — diff payload for N
// scenarios. MUST be registered before `GET /:kind/:id` so Express doesn't
// match the literal "compare" as the `:id` param.
router.get('/:kind/compare', async (req, res, next) => {
  try {
    const cfg = cfgOf(res);
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
    // partial-permission compare can't leak any rows. Corp additionally
    // enforces every entity be corp (personal's guard is undefined → no check).
    const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
    const entities = await Entity.findAll({ where: { id: entityIds } });
    if (entities.some((e) => e.householdId !== household.id)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (
      cfg.entityKindGuard !== undefined &&
      entities.some((e) => e.kind !== cfg.entityKindGuard)
    ) {
      res.status(400).json({ error: `not_${cfg.entityKindGuard}` });
      return;
    }
    const computedAll = await Promise.all(
      scenarios.map(async (s) => ({
        scenario: s,
        computed: await cfg.compute(s.id),
      })),
    );
    res.json({ scenarios: computedAll });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/scenarios/:kind/:id/chain — walk the multi-year chain a
// scenario belongs to, returning all scenarios in year order along with their
// computed returns.
//
// The chain represents year-to-year progression (baseline year N → projection
// year N+1 → ...). Forks within a single year are siblings, not part of the
// chain; calling /chain on a fork returns the year-chain that fork's parent
// belongs to (if any), or the fork itself as a single-entry chain.
//
// MUST be registered before `GET /:kind/:id` so Express doesn't match the
// literal "chain" as the `:id` param. Same pattern as `/compare`.
//
// Algorithm:
//   1. Walk parentId backwards collecting ancestry (root-first).
//   2. Find the earliest ancestor whose `nextYearId` is non-null — that's the
//      year-N anchor of the chain. If no ancestor has nextYearId, the leaf
//      itself is the entire chain (single entry).
//   3. Walk forwards via nextYearId from the anchor, collecting each
//      scenario + its computed return.
router.get(
  '/:kind/:id/chain',
  withScenario(async (_req, res, { scenario }) => {
    const cfg = cfgOf(res);
    // Step 1: walk parentId backwards collecting ancestry root-first.
    const MAX_DEPTH = 32;
    const ancestry: Scenario[] = [];
    const seen = new Set<number>();
    let cursor: Scenario | null = scenario;
    while (cursor !== null) {
      if (seen.has(cursor.id)) {
        throw new Error(`scenario ancestry cycle detected at id=${cursor.id}`);
      }
      seen.add(cursor.id);
      if (ancestry.length >= MAX_DEPTH) {
        throw new Error(`scenario ancestry exceeds max depth ${MAX_DEPTH}`);
      }
      ancestry.unshift(cursor);
      cursor =
        cursor.parentId !== null ? await Scenario.findByPk(cursor.parentId) : null;
    }

    // Step 2: find the earliest scenario in ancestry that starts a forward
    // chain (has nextYearId set). If none, the leaf is a single-entry chain.
    const anchor: Scenario =
      ancestry.find((s) => s.nextYearId !== null) ?? scenario;

    // Step 3: walk forwards via nextYearId, collecting + computing.
    const chainScenarios: Scenario[] = [anchor];
    const seenForward = new Set<number>([anchor.id]);
    let fwd: Scenario | null = anchor;
    while (fwd && fwd.nextYearId !== null) {
      if (chainScenarios.length >= MAX_DEPTH) {
        throw new Error(`scenario chain exceeds max depth ${MAX_DEPTH}`);
      }
      if (seenForward.has(fwd.nextYearId)) {
        throw new Error(`scenario chain cycle detected at id=${fwd.nextYearId}`);
      }
      const nextNode: Scenario | null = await Scenario.findByPk(fwd.nextYearId);
      if (!nextNode) break;
      seenForward.add(nextNode.id);
      chainScenarios.push(nextNode);
      fwd = nextNode;
    }

    const chain = await Promise.all(
      chainScenarios.map(async (s) => ({
        scenario: s,
        computed: await cfg.compute(s.id),
      })),
    );
    res.json({ chain });
  }),
);

// GET /api/tax/scenarios/:kind/:id — get a scenario + its computed return
// (cached on facts hash; recomputed on miss).
router.get(
  '/:kind/:id',
  withScenario(async (_req, res, { scenario }) => {
    const cfg = cfgOf(res);
    const computed = await cfg.compute(scenario.id);
    res.json({ scenario, computed });
  }),
);

// PATCH /api/tax/scenarios/:kind/:id — update name / notes / overrides /
// assumptions. Overrides go through the same validator the POST handler uses.
router.patch(
  '/:kind/:id',
  withScenario(async (req, res, { scenario }) => {
    const cfg = cfgOf(res);
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
        cfg.validateOverrides(req.body.overrides);
      } catch (err) {
        res
          .status(400)
          .json({ error: 'invalid_overrides', message: (err as Error).message });
        return;
      }
      updates.overrides = req.body.overrides;
    }
    if ('assumptions' in req.body) updates.assumptions = req.body.assumptions;
    await scenario.update(updates);
    res.json({ scenario });
  }),
);

// DELETE /api/tax/scenarios/:kind/:id — delete a fork. Refuses baselines
// (the baseline is the engine's anchor for actuals) and any node that still
// has children (the foreign key uses RESTRICT, but checking here gives a clear
// 409 rather than an opaque DB error).
router.delete(
  '/:kind/:id',
  withScenario(async (_req, res, { scenario }) => {
    if (scenario.kind === 'baseline') {
      res.status(409).json({ error: 'baseline_cannot_be_deleted' });
      return;
    }
    const childCount = await Scenario.count({ where: { parentId: scenario.id } });
    if (childCount > 0) {
      res.status(409).json({
        error: 'has_children',
        message: `Cannot delete scenario with ${childCount} descendant(s).`,
      });
      return;
    }
    await scenario.destroy();
    res.status(204).end();
  }),
);

// POST /api/tax/scenarios/:kind/:id/fork — create a child scenario whose
// effective facts inherit from the parent via ancestry resolution. The new
// scenario starts with an empty override map; inheritance is by walking the
// parent chain at compute time, not by duplicating overrides.
router.post(
  '/:kind/:id/fork',
  withScenario(async (req, res, { scenario }) => {
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim() !== ''
        ? req.body.name
        : `${scenario.name} (fork)`;
    const child = await Scenario.create({
      parentId: scenario.id,
      householdPlanId: scenario.householdPlanId,
      entityId: scenario.entityId,
      year: scenario.year,
      name,
      kind: 'fork',
      overrides: {},
      assumptions: {},
      nextYearId: null,
      notes: null,
    });
    res.status(201).json({ scenario: child });
  }),
);

// POST /api/tax/scenarios/:kind/:id/project-next-year — create a
// projection_root scenario for year+1 chained to `:id` via `next_year_id`.
// Idempotent: if a projection_root already exists for the same entity+next
// year, returns 409 with the existing scenario so callers can recover the
// link without creating a duplicate.
router.post(
  '/:kind/:id/project-next-year',
  withScenario(async (req, res, { scenario }) => {
    if (scenario.kind === 'projection_root') {
      // Block chaining two projection_root scenarios in a single hop — the
      // resolver requires a baseline (or fork) as the year-N anchor.
      res.status(400).json({
        error: 'already_projection_root',
        message:
          'Cannot project from a projection_root scenario; project from a baseline or fork.',
      });
      return;
    }
    const nextYear = scenario.year + 1;
    const existing = await Scenario.findOne({
      where: {
        entityId: scenario.entityId,
        year: nextYear,
        kind: 'projection_root',
      },
    });
    if (existing) {
      res.status(409).json({
        error: 'projection_already_exists',
        message: `A projection_root scenario already exists for entity ${scenario.entityId} year ${nextYear}.`,
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
      parentId: scenario.id,
      householdPlanId: scenario.householdPlanId,
      entityId: scenario.entityId,
      year: nextYear,
      name,
      kind: 'projection_root',
      overrides: {},
      assumptions,
      nextYearId: null,
      notes: null,
    });
    // Link the chain forward: parent.nextYearId now points at the new
    // projection so GET /:kind/:id/chain can walk year N → N+1.
    await scenario.update({ nextYearId: projection.id });
    res.status(201).json({ scenario: projection });
  }),
);

// POST /api/tax/scenarios/:kind/:id/compute — force a recompute, bypassing
// the facts-hash cache. Always writes a fresh ScenarioReturn row.
router.post(
  '/:kind/:id/compute',
  withScenario(async (_req, res, { scenario }) => {
    const cfg = cfgOf(res);
    const computed = await cfg.compute(scenario.id, { force: true });
    res.json({ computed });
  }),
);

export default router;
