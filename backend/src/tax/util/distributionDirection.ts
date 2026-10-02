import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Entity, type Transaction } from '../../models';

/** Treatments that say money went FROM the corporation TO the person. */
const DISTRIBUTION_TREATMENTS = new Set<string>([
  'eligible_dividend', 'non_eligible_dividend', 'salary', 'employment_income',
]);

/** Entity id → kind for one household, for checking many rows at once. */
export async function entityKindsFor(householdId: number): Promise<Map<number, string>> {
  const entities = await Entity.findAll({ where: { householdId }, attributes: ['id', 'kind'] });
  return new Map(entities.map((e) => [e.id, e.kind]));
}

/**
 * Whether a row could be one leg of a corp→person distribution: an inflow on a
 * personal (or unassigned) entity, or an outflow on a corporate one.
 */
function isDistributionDirection(txn: Transaction, kind: string | undefined): boolean {
  const amount = Number(txn.amount);
  if (kind === 'corp') return amount < 0;
  return amount > 0;
}

/**
 * Throws a 400 when `treatment` is a dividend or salary but `txn` moves money
 * INTO the corporation — that money is a loan or capital, never a distribution.
 * Callers run this inside their DB transaction so the throw rolls the write back.
 *
 * `kinds` is the household's entity-kind map when the caller checks many rows;
 * without it the row's own entity is looked up.
 */
export async function assertDistributionDirection(
  txn: Transaction,
  treatment: unknown,
  opts: { kinds?: Map<number, string>; transaction?: SequelizeTransaction } = {},
): Promise<void> {
  if (typeof treatment !== 'string' || !DISTRIBUTION_TREATMENTS.has(treatment)) return;
  let kind: string | undefined;
  if (txn.entityId != null) {
    kind = opts.kinds
      ? opts.kinds.get(txn.entityId)
      : (await Entity.findByPk(txn.entityId, { attributes: ['kind'], transaction: opts.transaction }))?.kind;
  }
  if (isDistributionDirection(txn, kind)) return;
  const err = new Error(
    `Transaction ${txn.id} moves money into the corporation; it cannot be a ${treatment}. `
    + 'Classify it as a loan or capital instead.',
  ) as Error & { status?: number };
  err.status = 400;
  throw err;
}
