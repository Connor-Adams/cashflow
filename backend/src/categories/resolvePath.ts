// backend/src/categories/resolvePath.ts
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { Category } from '../models';
import { sequelize } from '../db';
import { parseCategoryPath } from './path';
import { normalizeCategoryName } from './normalizeName';

export interface ResolvedPath {
  leafId: number;
  createdIds: number[];
}

/**
 * Find an existing node for this name ANYWHERE in the household.
 *
 * Category names are unique per household (categories_household_name_key_unique),
 * so a path is a hint about where a NEW category belongs, not an address: if the
 * name already exists the walk reuses that node whatever its parent, and never
 * reparents it. Resolving parent-scoped is what let the nightly enrichment job
 * fork 15 categories into duplicate roots on 2026-09-29 — see
 * docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
 */
async function findByName(
  householdId: number,
  nameKey: string,
  transaction: Transaction,
): Promise<Category | null> {
  return Category.findOne({ where: { householdId, nameKey }, transaction });
}

export async function resolveCategoryPath(
  householdId: number,
  input: string,
  opts: { transaction?: Transaction } = {},
): Promise<ResolvedPath> {
  const segments = parseCategoryPath(input);

  const run = async (transaction: Transaction): Promise<ResolvedPath> => {
    let parentId: number | null = null;
    const createdIds: number[] = [];
    let leafId = 0;
    for (const segment of segments) {
      const nameKey = normalizeCategoryName(segment);
      let node = await findByName(householdId, nameKey, transaction);
      if (!node) {
        try {
          node = await Category.create(
            { householdId, parentId, name: segment, icon: null },
            { transaction },
          );
          createdIds.push(node.id);
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            node = await findByName(householdId, nameKey, transaction);
          }
          if (!node) throw err;
        }
      }
      parentId = node.id;
      leafId = node.id;
    }
    return { leafId, createdIds };
  };

  if (opts.transaction) return run(opts.transaction);
  return sequelize.transaction((t) => run(t));
}
