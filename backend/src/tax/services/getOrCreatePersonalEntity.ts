// Import Entity directly from its model module (not the '../../models' barrel)
// to avoid a circular dependency: the barrel imports Account, Account lazily
// imports this helper, and this helper would import the barrel — a cycle that
// fallow flags. Entity.ts depends only on sequelize, so the direct import is
// acyclic. The class reference is identical either way (the barrel's index.ts
// still runs initEntity + associations at startup), so behavior is unchanged.
import { Entity } from '../../models/Entity';
import type { Transaction as SequelizeTransaction } from 'sequelize';

/**
 * Returns the household's single `personal` tax Entity, creating it on demand.
 *
 * No production code path created a personal Entity at household creation —
 * historically only the one-time backfill migration (20260525000008) did, so
 * households created after that migration had none. The account-creation hook
 * relies on this helper to guarantee a personal entity exists to default to.
 *
 * Idempotent: a (household_id, kind='personal') invariant is held at the app
 * level. Pass `transaction` so creation participates in the caller's unit of
 * work (the Account hook fills entity_id inside the same insert transaction).
 */
export async function getOrCreatePersonalEntity(
  householdId: number,
  options?: { transaction?: SequelizeTransaction },
): Promise<InstanceType<typeof Entity>> {
  const [entity] = await Entity.findOrCreate({
    where: { householdId, kind: 'personal' },
    defaults: {
      householdId,
      kind: 'personal',
      legalName: 'Personal',
      jurisdiction: 'CA-ON',
    },
    transaction: options?.transaction,
  });
  return entity;
}
