'use strict';

// Backfill categories from every existing distinct (household_id, category) seen
// in transactions.final_category, rules.category, and budget_targets.category.
// `icon` is left NULL — users will assign icons via Settings → Categories.
//
// Uses INSERT ... SELECT with NOT EXISTS so we never violate the unique
// (household_id, name) index, even if the same value appears in two source
// tables. Works against both sqlite and postgres.

module.exports = {
  async up(queryInterface) {
    const sql = `
      INSERT INTO categories (household_id, name, icon, created_at, updated_at)
      SELECT DISTINCT src.household_id, TRIM(src.category) AS name, NULL,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM (
        SELECT household_id, final_category AS category FROM transactions
         WHERE final_category IS NOT NULL AND TRIM(final_category) <> ''
           AND household_id IS NOT NULL
        UNION
        SELECT household_id, category FROM rules
         WHERE category IS NOT NULL AND TRIM(category) <> ''
           AND household_id IS NOT NULL
        UNION
        SELECT household_id, category FROM budget_targets
         WHERE category IS NOT NULL AND TRIM(category) <> ''
           AND household_id IS NOT NULL
      ) AS src
      WHERE NOT EXISTS (
        SELECT 1 FROM categories c
        WHERE c.household_id = src.household_id
          AND c.name = TRIM(src.category)
      );
    `;
    await queryInterface.sequelize.query(sql);
  },

  async down() {
    // Non-destructive on rollback — categories backfilled here may have icons
    // assigned afterwards. Use the previous migration's down() to drop the table.
  },
};
