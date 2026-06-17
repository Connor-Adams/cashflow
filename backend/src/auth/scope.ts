import type { Request } from 'express';
import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { currentAuth } from './middleware';

export function isSuperadmin(req: Request): boolean {
  return currentAuth(req).user.globalRole === 'superadmin';
}

export function householdWhere(req: Request): WhereOptions {
  if (isSuperadmin(req)) return {};
  const { household } = currentAuth(req);
  return { householdId: household.id };
}

export function visibleTransactionWhere(req: Request): WhereOptions {
  if (isSuperadmin(req)) return {};
  const { household, user } = currentAuth(req);
  return {
    householdId: household.id,
    [Op.or]: [{ visibility: 'shared' }, { createdByUserId: user.id }],
  } as WhereOptions;
}

export function visibleAccountWhere(req: Request): WhereOptions {
  if (isSuperadmin(req)) return {};
  const { household, user } = currentAuth(req);
  return {
    householdId: household.id,
    [Op.or]: [{ visibility: 'shared' }, { ownerUserId: user.id }],
  } as WhereOptions;
}

/**
 * Scope for rows that carry `createdByUserId` + `visibility` but NOT
 * `ownerUserId` (e.g. AccountStatement). Mirrors {@link visibleTransactionWhere}
 * but kept as a separate name so future divergence is non-invasive.
 */
export function visibleStatementWhere(req: Request): WhereOptions {
  if (isSuperadmin(req)) return {};
  const { household, user } = currentAuth(req);
  return {
    householdId: household.id,
    [Op.or]: [{ visibility: 'shared' }, { createdByUserId: user.id }],
  } as WhereOptions;
}
