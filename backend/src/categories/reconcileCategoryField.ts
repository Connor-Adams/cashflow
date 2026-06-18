import type { Transaction } from 'sequelize';
import { Category } from '../models/Category';
import { resolveCategoryIdByName } from './resolveCategoryId';

interface FieldInstance {
  changed(f: string): boolean;
  get(f: string): unknown;
  set(f: string, v: unknown): void;
}

/**
 * Id-authoritative reconciliation of one (string, id) category pair on a model
 * instance, for a beforeSave hook:
 *  - if the id field changed → the id wins; derive the string mirror from the
 *    referenced node's leaf name (null id → null string). Do not re-resolve.
 *  - else if the string field changed → resolve it to a ROOT category id
 *    (legacy create-by-name path).
 *  - else → no-op.
 */
export async function reconcileCategoryField(opts: {
  instance: FieldInstance;
  householdId: number;
  strField: string;
  idField: string;
  transaction?: Transaction;
}): Promise<void> {
  const { instance, householdId, strField, idField, transaction } = opts;
  if (instance.changed(idField)) {
    const id = instance.get(idField) as number | null;
    if (id == null) {
      instance.set(strField, null);
      return;
    }
    const node = await Category.findOne({ where: { id, householdId }, transaction });
    instance.set(strField, node ? node.name : null);
    return;
  }
  if (instance.changed(strField)) {
    const str = instance.get(strField) as string | null;
    instance.set(idField, await resolveCategoryIdByName(householdId, str, { transaction }));
  }
}
