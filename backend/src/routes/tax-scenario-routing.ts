// backend/src/routes/tax-scenario-routing.ts
//
// Shared routing helpers for the unified `/api/tax/scenarios/:kind` route
// (issue #377). Personal + corp scenarios used to live in two near-identical
// route files; they are now one router that discriminates on the `:kind` path
// segment and selects the override validator + resolve/compute layer from the
// `SCENARIO_KIND_CONFIG` lookup table below.
//
// This module exports three things:
//   1. `SCENARIO_KIND_CONFIG` — the per-kind variant table (validator scope,
//      baseline-ensure fn, compute fn, and whether the `:id` auth wrapper
//      enforces entity kind). Personal is intentionally lax on the kind guard
//      (`entityKindGuard: undefined`) to preserve its historical behaviour;
//      corp enforces `'corp'`.
//   2. `withAuthorizedScenario(expectedKind, handler)` — the `:id` auth wrapper.
//   3. helpers for parsing/validating the `:kind` path segment.
//
// `withAuthorizedScenario(expectedKind, handler)` wraps a handler with:
//   1. params.id parsing
//   2. scenario + entity load
//   3. household ownership check
//   4. optional entity-kind check (corp passes 'corp'; personal passes
//      undefined — the personal handlers never historically enforced kind)
//   5. error → HTTP status mapping
//   6. try/catch → next(err)
//
// The handler receives the already-authorized `{scenario, entity}` ctx.
import type { NextFunction, Request, Response } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';
import type { OverrideMap } from '../tax/scenarios/types';
import { validateOverrideMap } from '../tax/scenarios/overrideKeys';
import { ensureBaselineScenario } from '../tax/scenarios/resolveScenario';
import { computeScenario } from '../tax/scenarios/computeScenario';
import { ensureCorpBaselineScenario } from '../tax/scenarios/resolveCorpScenario';
import { computeCorpScenario } from '../tax/scenarios/computeCorpScenario';

export type ScenarioEntityKind = 'corp' | 'personal';
type WrongKind = `not_${ScenarioEntityKind}`;
export type ScenarioAuthError = 'not_found' | 'forbidden' | WrongKind;

export interface ComputeOptions {
  force?: boolean;
}

/**
 * Per-kind variant table. The unified route reads `SCENARIO_KIND_CONFIG[kind]`
 * once per request and dispatches through it — no `if (kind === 'corp')`
 * branching in the handlers.
 *
 * - `entityKindGuard`: passed to `withAuthorizedScenario` for `:id` endpoints.
 *   `undefined` → no entity-kind enforcement (personal's historical laxness);
 *   `'corp'` → reject non-corp entities with 400 `not_corp`.
 * - `validateOverrides`: scoped override-key validator (throws on invalid key).
 * - `ensureBaseline`: auto-creates the (entityId, year) baseline scenario.
 * - `compute`: returns a scenario's computed return (cached unless `force`).
 */
export interface ScenarioKindConfig {
  kind: ScenarioEntityKind;
  entityKindGuard: ScenarioEntityKind | undefined;
  validateOverrides: (map: OverrideMap) => void;
  ensureBaseline: (entityId: number, year: number) => Promise<Scenario>;
  compute: (scenarioId: number, opts?: ComputeOptions) => Promise<unknown>;
}

export const SCENARIO_KIND_CONFIG: Record<ScenarioEntityKind, ScenarioKindConfig> = {
  personal: {
    kind: 'personal',
    // Personal endpoints historically never enforced entity-kind on :id.
    entityKindGuard: undefined,
    validateOverrides: (map) => validateOverrideMap(map, 'personal'),
    ensureBaseline: ensureBaselineScenario,
    compute: computeScenario,
  },
  corp: {
    kind: 'corp',
    entityKindGuard: 'corp',
    validateOverrides: (map) => validateOverrideMap(map, 'corp'),
    ensureBaseline: ensureCorpBaselineScenario,
    compute: computeCorpScenario,
  },
};

export function isScenarioEntityKind(value: unknown): value is ScenarioEntityKind {
  return value === 'personal' || value === 'corp';
}

export interface AuthorizedScenario {
  scenario: Scenario;
  entity: Entity;
}

export async function loadAndAuthorizeScenario(
  req: Request,
  scenarioId: number,
  expectedKind?: ScenarioEntityKind,
): Promise<AuthorizedScenario | { error: ScenarioAuthError }> {
  const { household } = currentAuth(req);
  if (!Number.isInteger(scenarioId)) return { error: 'not_found' };
  const scenario = await Scenario.findByPk(scenarioId);
  if (!scenario) return { error: 'not_found' };
  const entity = await Entity.findByPk(scenario.entityId);
  if (!entity || entity.householdId !== household.id) {
    return { error: 'forbidden' };
  }
  if (expectedKind !== undefined && entity.kind !== expectedKind) {
    return { error: `not_${expectedKind}` as WrongKind };
  }
  return { scenario, entity };
}

export function mapAuthErrorStatus(error: ScenarioAuthError): number {
  if (error === 'not_found') return 404;
  if (error === 'forbidden') return 403;
  return 400; // not_corp / not_personal
}

export type ScenarioRouteHandler = (
  req: Request,
  res: Response,
  ctx: AuthorizedScenario,
) => Promise<void>;

export function withAuthorizedScenario(
  expectedKind: ScenarioEntityKind | undefined,
  handler: ScenarioRouteHandler,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await loadAndAuthorizeScenario(
        req,
        Number(req.params.id),
        expectedKind,
      );
      if ('error' in result) {
        res
          .status(mapAuthErrorStatus(result.error))
          .json({ error: result.error });
        return;
      }
      await handler(req, res, result);
    } catch (err) {
      next(err);
    }
  };
}
