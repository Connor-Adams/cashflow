// backend/src/routes/tax-household-plans.ts
//
// CRUD + compute routes for HouseholdPlan groupings (P8b Task 6). A
// HouseholdPlan ties N scenarios (1 corp + 1 personal in the simplest case)
// into a single integrated evaluation so a salary-vs-dividend decision can be
// measured end-to-end.
//
// All endpoints are mounted under `/api/tax/household-plans` and require auth
// (the global `requireAuth` middleware at `/api` enforces this). Every handler
// re-checks `household.id` ownership of the plan so cross-household requests
// 403 even with a valid session.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { currentAuth } from '../auth/middleware';
import { HouseholdPlan, Scenario } from '../models';
import { computeHouseholdPlan } from '../tax/scenarios/computeHouseholdPlan';

const router = Router();

// Wraps an `:id` handler: parses the param, loads the plan, enforces the
// caller's household owns it, and funnels thrown errors into `next`. Cuts the
// 14-line auth/lookup preamble that otherwise repeats in every `:id` route.
type OwnedPlanHandler = (
  req: Request,
  res: Response,
  plan: HouseholdPlan,
) => Promise<void>;

function withOwnedPlan(handler: OwnedPlanHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { household } = currentAuth(req);
      const planId = Number(req.params.id);
      if (!Number.isInteger(planId)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const plan = await HouseholdPlan.findByPk(planId);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.householdId !== household.id) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      await handler(req, res, plan);
    } catch (err) {
      next(err);
    }
  };
}

// POST /api/tax/household-plans — create a new plan owned by the caller's
// household. Scenario linkage is via PATCH (`addScenarioIds`); a freshly
// created plan starts with zero linked scenarios.
router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { name, notes = null } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({
        error: 'invalid_body',
        message: 'name (non-empty string) required',
      });
      return;
    }
    const plan = await HouseholdPlan.create({
      householdId: household.id,
      name,
      notes: notes === null ? null : String(notes),
    });
    res.status(201).json({ plan });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/household-plans — list every plan owned by the caller's
// household, ordered by creation time so the picker UI renders deterministic
// order.
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const plans = await HouseholdPlan.findAll({
      where: { householdId: household.id },
      order: [['createdAt', 'ASC']],
    });
    res.json({ plans });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/household-plans/:id/compute — run the integration pipeline:
// compute corp scenarios, route distributions via integrationRouter, inject
// additions into personal facts, compute personal scenarios. Returns the
// integrated bundle (corp + personal + integration).
//
// MUST be registered BEFORE `GET /:id` so Express doesn't match the literal
// "compute" segment as the `:id` param. Same pattern as P7's `/compare` and
// P8a's `/compare`.
router.get(
  '/:id/compute',
  withOwnedPlan(async (_req, res, plan) => {
    const result = await computeHouseholdPlan(plan.id);
    res.json(result);
  }),
);

// GET /api/tax/household-plans/:id — fetch the plan + every Scenario linked
// to it (ordered by createdAt for stable rendering). Useful for the
// HouseholdPlanPicker detail view.
router.get(
  '/:id',
  withOwnedPlan(async (_req, res, plan) => {
    const scenarios = await Scenario.findAll({
      where: { householdPlanId: plan.id },
      order: [['createdAt', 'ASC']],
    });
    res.json({ plan, scenarios });
  }),
);

// PATCH /api/tax/household-plans/:id — update name/notes AND/OR link
// scenarios in/out of the plan via `addScenarioIds` / `removeScenarioIds`.
// Linking is intentionally lax: passing IDs the caller doesn't own would
// orphan-link them, so we filter the update through the scenarios' entities'
// household ownership before applying.
router.patch(
  '/:id',
  withOwnedPlan(async (req, res, plan) => {
    const { household } = currentAuth(req);
    const planId = plan.id;

    const updates: Partial<{ name: string; notes: string | null }> = {};
    if (req.body && 'name' in req.body) updates.name = String(req.body.name);
    if (req.body && 'notes' in req.body) {
      updates.notes = req.body.notes === null ? null : String(req.body.notes);
    }
    if (Object.keys(updates).length > 0) await plan.update(updates);

    const addIds: number[] = Array.isArray(req.body?.addScenarioIds)
      ? (req.body.addScenarioIds as unknown[]).filter(
          (n): n is number => typeof n === 'number' && Number.isInteger(n),
        )
      : [];
    const removeIds: number[] = Array.isArray(req.body?.removeScenarioIds)
      ? (req.body.removeScenarioIds as unknown[]).filter(
          (n): n is number => typeof n === 'number' && Number.isInteger(n),
        )
      : [];

    if (addIds.length > 0) {
      // Authorize: only link scenarios whose underlying entity belongs to the
      // caller's household. A foreign scenario ID silently gets dropped from
      // the add list rather than 403'ing the whole request — the alternative
      // would let a probe API discover scenario IDs by status code.
      const candidates = await Scenario.findAll({ where: { id: addIds } });
      const { Entity } = await import('../models');
      const entityIds = Array.from(new Set(candidates.map((s) => s.entityId)));
      const entities = await Entity.findAll({ where: { id: entityIds } });
      const ownedEntityIds = new Set(
        entities.filter((e) => e.householdId === household.id).map((e) => e.id),
      );
      const ownedScenarioIds = candidates
        .filter((s) => ownedEntityIds.has(s.entityId))
        .map((s) => s.id);
      if (ownedScenarioIds.length > 0) {
        await Scenario.update(
          { householdPlanId: planId },
          { where: { id: ownedScenarioIds } },
        );
      }
    }
    if (removeIds.length > 0) {
      // Symmetric: only unlink scenarios currently linked to THIS plan.
      // Prevents an unrelated plan's scenarios from being unlinked by an
      // attacker who guessed an ID.
      await Scenario.update(
        { householdPlanId: null },
        { where: { id: removeIds, householdPlanId: planId } },
      );
    }
    res.json({ plan });
  }),
);

// DELETE /api/tax/household-plans/:id — delete the plan. Linked scenarios
// stay (FK onDelete:'SET NULL' handles it; we also explicitly unlink for
// clarity and to keep the post-delete state predictable across DB engines).
router.delete(
  '/:id',
  withOwnedPlan(async (_req, res, plan) => {
    await Scenario.update(
      { householdPlanId: null },
      { where: { householdPlanId: plan.id } },
    );
    await plan.destroy();
    res.status(204).end();
  }),
);

export default router;
