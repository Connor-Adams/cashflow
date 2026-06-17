'use strict';

// (table, fkColumn, sourceStringColumn, hasHouseholdId)
const TARGETS = [
  ['transactions', 'auto_category_id', 'auto_category', true],
  ['transactions', 'category_override_id', 'category_override', true],
  ['transactions', 'final_category_id', 'final_category', true],
  ['external_order_items', 'inferred_category_id', 'inferred_category', false],
  ['external_order_items', 'category_override_id', 'category_override', false],
  ['rules', 'category_id', 'category', true],
  ['budget_targets', 'category_id', 'category', true],
];

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add nullable INTEGER columns WITHOUT a DB-level `references`/FK clause.
    //    On SQLite, addColumn WITH a references clause can trigger a full table
    //    rebuild, which corrupts pre-existing foreign keys on heavily-FK'd tables
    //    like `transactions` (same class of failure as Plan A's rename-recreate).
    //    The relationship is enforced at the app layer (resolveCategoryIdByName
    //    only ever sets valid category ids) and via the model associations under
    //    sync; a plain nullable column is dual-dialect safe and rebuild-free.
    for (const [table, fkCol] of TARGETS) {
      await queryInterface.addColumn(table, fkCol, {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    // 2. Backfill. external_order_items has no household_id, so resolve its
    //    category via the order's transaction link is out of scope for the
    //    backfill — instead match against ANY root category with the same
    //    name_key (item categories are household-agnostic strings today;
    //    a cross-household name collision is acceptable for a one-time backfill
    //    and is corrected on the next write via the model hook).
    const [cats] = await queryInterface.sequelize.query(
      'SELECT id, household_id, name_key FROM categories WHERE parent_id IS NULL',
    );
    const rootByHouseholdKey = new Map(); // `${household_id}\0${name_key}` -> id
    const rootByKey = new Map(); // name_key -> id (first wins; for item fallback)
    for (const c of cats) {
      rootByHouseholdKey.set(`${c.household_id}\0${normalizeName(c.name_key)}`, c.id);
      if (!rootByKey.has(normalizeName(c.name_key))) rootByKey.set(normalizeName(c.name_key), c.id);
    }

    for (const [table, fkCol, srcCol, hasHousehold] of TARGETS) {
      const cols = hasHousehold
        ? `id, household_id, ${srcCol} AS src`
        : `id, ${srcCol} AS src`;
      const [rows] = await queryInterface.sequelize.query(`SELECT ${cols} FROM ${table}`);
      for (const row of rows) {
        if (row.src == null || String(row.src).trim() === '') continue;
        const key = normalizeName(row.src);
        const id = hasHousehold
          ? rootByHouseholdKey.get(`${row.household_id}\0${key}`)
          : rootByKey.get(key);
        if (id == null) continue;
        await queryInterface.sequelize.query(
          `UPDATE ${table} SET ${fkCol} = :id WHERE id = :rowId`,
          { replacements: { id, rowId: row.id } },
        );
      }
    }
  },

  async down(queryInterface) {
    for (const [table, fkCol] of TARGETS) {
      await queryInterface.removeColumn(table, fkCol);
    }
  },
};
