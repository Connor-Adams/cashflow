'use strict';

// (table, fkColumn, sourceStringColumn, hasHouseholdId) — same targets as 20260622000001, re-resolving only NULL fks.
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
  async up(queryInterface) {
    const [cats] = await queryInterface.sequelize.query(
      'SELECT id, household_id, name_key FROM categories WHERE parent_id IS NULL',
    );
    const byHouseholdKey = new Map();
    const byKey = new Map();
    for (const c of cats) {
      byHouseholdKey.set(`${c.household_id}:${c.name_key}`, c.id);
      if (!byKey.has(c.name_key)) byKey.set(c.name_key, c.id);
    }
    for (const [table, fkCol, srcCol, hasHousehold] of TARGETS) {
      const cols = hasHousehold ? `id, household_id, ${srcCol} AS src` : `id, ${srcCol} AS src`;
      const [rows] = await queryInterface.sequelize.query(
        `SELECT ${cols} FROM ${table} WHERE ${fkCol} IS NULL AND ${srcCol} IS NOT NULL`,
      );
      for (const row of rows) {
        if (String(row.src).trim() === '') continue;
        const key = normalizeName(row.src);
        const id = hasHousehold ? byHouseholdKey.get(`${row.household_id}:${key}`) : byKey.get(key);
        if (id == null) continue;
        await queryInterface.sequelize.query(
          `UPDATE ${table} SET ${fkCol} = :id WHERE id = :rowId`,
          { replacements: { id, rowId: row.id } },
        );
      }
    }
  },

  // Data-only backfill; down is a no-op (cannot distinguish backfilled from hook-set ids).
  async down() {},
};
