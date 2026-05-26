// backend/src/routes/tax-scenario-routing.ts
//
// Shared `:id` auth wrapper for the corp + personal scenario routes. Both
// route files used to inline a near-identical 7-line preamble in every `:id`
// handler:
//
//   const result = await loadAndAuthorize(req, Number(req.params.id));
//   if ('error' in result) {
//     const status =
//       result.error === 'not_found' ? 404 :
//       result.error === 'forbidden' ? 403 : 400;
//     res.status(status).json({ error: result.error });
//     return;
//   }
//
// `withAuthorizedScenario(expectedKind, handler)` wraps a handler with:
//   1. params.id parsing
//   2. scenario + entity load
//   3. household ownership check
//   4. optional entity-kind check (corp endpoints pass 'corp'; personal pass
//      'personal' — the personal handlers never historically enforced kind,
//      so callers can omit `expectedKind` to keep that lax behaviour)
//   5. error → HTTP status mapping
//   6. try/catch → next(err)
//
// The handler receives the already-authorized `{scenario, entity}` ctx.
import type { NextFunction, Request, Response } from 'express';
import { currentAuth } from '../auth/middleware';
import { Entity, Scenario } from '../models';

export type ScenarioEntityKind = 'corp' | 'personal';
type WrongKind = `not_${ScenarioEntityKind}`;
export type ScenarioAuthError = 'not_found' | 'forbidden' | WrongKind;

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
