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

async function findSibling(
  householdId: number,
  parentId: number | null,
  nameKey: string,
  transaction: Transaction,
): Promise<Category | null> {
  return Category.findOne({ where: { householdId, parentId, nameKey }, transaction });
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
      let node = await findSibling(householdId, parentId, nameKey, transaction);
      if (!node) {
        try {
          node = await Category.create(
            { householdId, parentId, name: segment.trim(), icon: null },
            { transaction },
          );
          createdIds.push(node.id);
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            node = await findSibling(householdId, parentId, nameKey, transaction);
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
