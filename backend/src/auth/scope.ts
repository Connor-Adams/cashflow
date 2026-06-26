import type { Request } from 'express';
import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { currentAuth } from './middleware';

export function isSuperadmin(req: Request): boolean {
  return currentAuth(req).user.globalRole === 'superadmin';
}

/**
 * True iff the caller may perform owner-only household mutations — removing a
 * member, or minting a household invite (#816). The owning role is server-
 * derived by `attachAuth` from `HouseholdMember.role` (never client-supplied),
 * so a `role === 'owner'` check is a sufficient privilege gate. Superadmins
 * bypass the gate, mirroring every other scope helper in this file.
 */
export function isHouseholdOwner(req: Request): boolean {
  if (isSuperadmin(req)) return true;
  return currentAuth(req).role === 'owner';
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
