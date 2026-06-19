'use strict';

/**
 * Per-label color (issue #794).
 *
 * Adds a nullable `color` column to `labels` so each label can carry a chip
 * tint (a 6-digit hex string, e.g. `#3B82F6`). NULL means "no color → render
 * the existing neutral chip", so pre-existing rows backfill to NULL and behave
 * exactly as before. STRING(7) holds `#RRGGBB`; no index (low-cardinality,
 * never filtered on).
 *
 * Down-migration SQLite caveat: `labels` carries a functional UNIQUE index on
 * `(household_id, LOWER(name))` (from 20260609000001-create-labels). SQLite has
 * no native DROP COLUMN, so Sequelize rebuilds the table — and it cannot
 * introspect/recreate an *expression* index, which throws
 * "Cannot set properties of undefined (setting 'unique')". So on SQLite we drop
 * that expression index first, remove the column, then recreate the index.
 * Postgres drops the column in place and needs none of this.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

const LOWER_NAME_INDEX_SQL =
  'CREATE UNIQUE INDEX labels_household_lower_name_unique ' +
  'ON labels (household_id, LOWER(name))';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('labels', 'color', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'sqlite') {
      // Drop the expression index so the table rebuild from removeColumn
      // doesn't trip over an index it can't reconstruct, then restore it.
      await queryInterface.sequelize.query(
        'DROP INDEX IF EXISTS labels_household_lower_name_unique',
      );
      await queryInterface.removeColumn('labels', 'color');
      await queryInterface.sequelize.query(LOWER_NAME_INDEX_SQL);
    } else {
      await queryInterface.removeColumn('labels', 'color');
    }
  },
};
