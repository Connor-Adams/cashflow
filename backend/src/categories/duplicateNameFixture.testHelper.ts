/**
 * Test-only escape hatch for building a shape the household-wide unique index
 * forbids.
 *
 * `categories_household_name_key_unique` — added by migration
 * `20260930000001-merge-duplicate-category-names.js`, declared on the `Category`
 * model, and therefore created by every `sequelize.sync()` a unit test runs —
 * makes two same-named categories in one household unrepresentable. That is the
 * point of it. But several code paths exist precisely as DEFENCE against that
 * shape: `resolveCategoryIdByName`'s root-preference and ambiguity branches,
 * `resolveCategoryPath`'s lowest-id tie-break, and `reparentCategory`'s
 * household-wide name guard. They can only be tested against the shape they
 * defend, which a database predating the migration (or a bulk writer going
 * around the model) can still hold.
 *
 * The index is NOT restored: restoring it would fail while the duplicate rows
 * the calling test just created are still present. Dropping it here also makes
 * the next `sync`'s `DROP TABLE` safe: SQLite's implicit delete promotes a
 * nested category to a root via `ON DELETE SET NULL`, which would otherwise
 * collide with the same-named root the test left behind and fail the drop
 * itself.
 *
 * CALLER REQUIREMENT, NOT AN ENFORCED INVARIANT: because nothing here puts the
 * index back, every caller MUST run `sequelize.sync({ force: true })` in a
 * `beforeEach` — that is what recreates the index from the model declaration for
 * the next test. All five current call sites do. A caller that synced in a
 * plain `before` instead would leave the index dropped for the REST of the file,
 * silently disarming it for every later test in that file, and nothing would
 * report it. If you add a call site, check its sync hook.
 */
import { sequelize } from '../db';

const INDEX = 'categories_household_name_key_unique';

export async function allowDuplicateCategoryNames(): Promise<void> {
  // Runtime fence: this lives under `src/categories/`, so production code can
  // import it. Dropping a uniqueness guarantee is never a production operation.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `allowDuplicateCategoryNames() drops the ${INDEX} unique index and is test-only, but ` +
        `NODE_ENV is ${JSON.stringify(process.env.NODE_ENV)}. Refusing to run.`,
    );
  }
  const qi = sequelize.getQueryInterface();
  // `showIndex` is typed as `Promise<object>` by sequelize 6; the runtime value is
  // the dialect's index-description array.
  const indexes = (await qi.showIndex('categories')) as Array<{ name: string }>;
  if (indexes.some((i) => i.name === INDEX)) await qi.removeIndex('categories', INDEX);
}
