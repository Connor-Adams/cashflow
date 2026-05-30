// backend/src/routes/tax-scenarios.ts
//
// Unified tax scenario route that dispatches on `kind` (`'personal'|'corp'`).
//
// Collection endpoints (GET /, POST /): require `kind` query param.
// Single-resource endpoints (GET /:id, PATCH /:id, DELETE /:id, POST /:id/*):
//   derive kind from the loaded entity — no `kind` query param needed.
//
// Mounted under `/api/tax/scenarios` in app.ts BEFORE the legacy
// `/api/tax/personal-scenarios` and `/api/tax/corp-scenarios` mounts (which
// now return 410 Gone).
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';
import { validateOverrideMap } from '../tax/scenarios/overrideKeys';
import { ensureBaselineScenario } from '../tax/scenarios/resolveScenario';
import { computeScenario } from '../tax/scenarios/computeScenario';
import { ensureCorpBaselineScenario } from '../tax/scenarios/resolveCorpScenario';
import { computeCorpScenario } from '../tax/scenarios/computeCorpScenario';
import { withAuthorizedScenario } from './tax-scenario-routing';

const router = Router();

// ---------------------------------------------------------------------------
// Kind dispatch table
// ---------------------------------------------------------------------------

type KindKey = 'personal' | 'corp';

interface KindDispatch {
  ensureBaseline: (entityId: number, year: number) => Promise<Scenario>;
  compute: (id: number, opts?: { force?: boolean }) => Promise<unknown>;
  validate: (o: unknown) => void;
  /** Entity kind that must match when enforcing kind on :id routes. */
  entityKind: string;
}

const DISPATCH: Record<KindKey, KindDispatch> = {
  personal: {
    ensureBaseline: ensureBaselineScenario,
    compute: computeScenario,
    validate: (o) => validateOverrideMap(o, 'personal'),
    entityKind: 'personal',
  },
  corp: {
    ensureBaseline: ensureCorpBaselineScenario,
    compute: computeCorpScenario,
    validate: (o) => validateOverrideMap(o, 'corp'),
    entityKind: 'corp',
  },
};

function parseKind(raw: unknown): KindKey | null {
  if (raw === 'personal' || raw === 'corp') return raw as KindKey;
  return null;
}

// ---------------------------------------------------------------------------
// Collection: GET / — list scenarios for an entity+year
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const kind = parseKind(req.query.kind);
    if (!kind) {
      res.status(400).json({
        error: 'invalid_query',
        message: "kind query param required (must be 'personal' or 'corp')",
      });
      return;
    }
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
    if (entity.kind !== DISPATCH[kind].entityKind) {
      res.status(400).json({
        error: `not_${kind}`,
        message: `entity id=${entityId} is kind=${entity.kind}, not ${kind}`,
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

// ---------------------------------------------------------------------------
// Collection: POST / — create a fork scenario
// ---------------------------------------------------------------------------

router.post('/', async (req, res, next) => {
  try {
    const kind = parseKind(req.query.kind);
    if (!kind) {
      res.status(400).json({
        error: 'invalid_query',
        message: "kind query param required (must be 'personal' or 'corp')",
      });
      return;
    }
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
    if (entity.kind !== DISPATCH[kind].entityKind) {
      res.status(400).json({
        error: `not_${kind}`,
        message: `entity id=${entityId} is kind=${entity.kind}, not ${kind}`,
      });
      return;
    }

    try {
      DISPATCH[kind].validate(overrides);
    } catch (err) {
      res
        .status(400)
        .json({ error: 'invalid_overrides', message: (err as Error).message });
      return;
    }

    // Auto-create the baseline so explicit forks always have a stable root.
    const baseline = await DISPATCH[kind].ensureBaseline(entityId, year);
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

// ---------------------------------------------------------------------------
// Single-resource helpers — derive kind from entity on :id routes
// ---------------------------------------------------------------------------

// All :id handlers use withAuthorizedScenario(undefined, ...) — no kind
// pre-filter — then look up the dispatch table via ctx.entity.kind.
const withScenario = (
  handler: Parameters<typeof withAuthorizedScenario>[1],
) => withAuthorizedScenario(undefined, handler);

function dispatchByEntity(entityKind: string): KindDispatch | null {
  if (entityKind === 'personal') return DISPATCH.personal;
  if (entityKind === 'corp') return DISPATCH.corp;
  return null;
}

// ---------------------------------------------------------------------------
// GET /compare — diff payload for N scenarios
// MUST be before `GET /:id` so Express doesn't match "compare" as :id.
// ---------------------------------------------------------------------------

router.get('/compare', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const idsRaw = String(req.query.ids ?? '');
    const ids = idsRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
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
    // household. One mismatched entity nukes the whole request (403).
    const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
    const entities = await Entity.findAll({ where: { id: entityIds } });
    if (entities.some((e) => e.householdId !== household.id)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Build entity-id → kind dispatch map so mixed-kind compares work.
    const entityById = new Map(entities.map((e) => [e.id, e]));
    const computedAll = await Promise.all(
      scenarios.map(async (s) => {
        const entity = entityById.get(s.entityId);
        const dispatch = entity ? dispatchByEntity(entity.kind) : null;
        if (!dispatch) {
          throw new Error(
            `Unknown entity kind for entity id=${s.entityId}`,
          );
        }
        return {
          scenario: s,
          computed: await dispatch.compute(s.id),
        };
      }),
    );
    res.json({ scenarios: computedAll });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id/chain — walk multi-year chain
// MUST be before `GET /:id`.
// ---------------------------------------------------------------------------

router.get(
  '/:id/chain',
  withScenario(async (_req, res, { scenario, entity }) => {
    const dispatch = dispatchByEntity(entity.kind);
    if (!dispatch) {
      res.status(400).json({ error: 'unsupported_entity_kind' });
      return;
    }

    const MAX_DEPTH = 32;

    // Step 1: walk parentId backwards collecting ancestry root-first.
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
        computed: await dispatch.compute(s.id),
      })),
    );
    res.json({ chain });
  }),
);

// ---------------------------------------------------------------------------
// GET /:id — get a scenario + its computed return
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  withScenario(async (_req, res, { scenario, entity }) => {
    const dispatch = dispatchByEntity(entity.kind);
    if (!dispatch) {
      res.status(400).json({ error: 'unsupported_entity_kind' });
      return;
    }
    const computed = await dispatch.compute(scenario.id);
    res.json({ scenario, computed });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /:id — update name / notes / overrides / assumptions
// ---------------------------------------------------------------------------

router.patch(
  '/:id',
  withScenario(async (req, res, { scenario, entity }) => {
    const dispatch = dispatchByEntity(entity.kind);
    if (!dispatch) {
      res.status(400).json({ error: 'unsupported_entity_kind' });
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
        dispatch.validate(req.body.overrides);
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

// ---------------------------------------------------------------------------
// DELETE /:id — delete a fork
// ---------------------------------------------------------------------------

router.delete(
  '/:id',
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

// ---------------------------------------------------------------------------
// POST /:id/fork — create a child scenario
// ---------------------------------------------------------------------------

router.post(
  '/:id/fork',
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

// ---------------------------------------------------------------------------
// POST /:id/project-next-year — create a projection_root for year+1
// ---------------------------------------------------------------------------

router.post(
  '/:id/project-next-year',
  withScenario(async (req, res, { scenario }) => {
    if (scenario.kind === 'projection_root') {
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
    // projection so GET /:id/chain can walk year N → N+1.
    await scenario.update({ nextYearId: projection.id });
    res.status(201).json({ scenario: projection });
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/compute — force a recompute, bypassing the facts-hash cache
// ---------------------------------------------------------------------------

router.post(
  '/:id/compute',
  withScenario(async (_req, res, { scenario, entity }) => {
    const dispatch = dispatchByEntity(entity.kind);
    if (!dispatch) {
      res.status(400).json({ error: 'unsupported_entity_kind' });
      return;
    }
    const computed = await dispatch.compute(scenario.id, { force: true });
    res.json({ computed });
  }),
);

export default router;
