'use strict';

/**
 * Adds contacts.normalized_name (lowercase + whitespace-collapsed key) and a
 * UNIQUE index (household_id, normalized_name) so Contact find-or-create by
 * normalized name is race-safe (mirrors accounts shortCode unique index).
 *
 * Backfill is done in JS to match normalizeContactName exactly (SQL lower()
 * cannot collapse internal whitespace portably). Per-household collisions
 * (e.g. "Jane Doe" + "JANE DOE") are disambiguated: the oldest id keeps the
 * base key, later rows get `${key}#${id}` so the unique index can be created
 * without data loss. NULLs are distinct in unique indexes on PG + SQLite.
 */
// Inlined to keep the migration self-contained (mirrors src/contacts/normalizeContactName.ts).
function normalize(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // Wrap the column add + JS backfill + index add in one transaction so an
    // interruption mid-backfill can't leave a half-applied migration (column
    // present, no index) that fails on re-run. PG + SQLite both support
    // transactional DDL.
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'contacts',
        'normalized_name',
        { type: Sequelize.STRING(160), allowNull: true },
        { transaction },
      );

      const [rows] = await queryInterface.sequelize.query(
        'SELECT id, household_id, name FROM contacts ORDER BY id ASC',
        { transaction },
      );
      const seen = new Map();
      for (const row of rows) {
        const base = normalize(row.name) || `contact-${row.id}`;
        let set = seen.get(row.household_id);
        if (!set) { set = new Set(); seen.set(row.household_id, set); }
        let key = base;
        if (set.has(key)) {
          // Disambiguate, bounded to the STRING(160) column so a long base
          // name + suffix can't overflow on Postgres (SQLite would truncate
          // silently, but PG raises "value too long").
          const suffix = `#${row.id}`;
          key = `${base.slice(0, 160 - suffix.length)}${suffix}`;
        }
        set.add(key);
        await queryInterface.sequelize.query(
          'UPDATE contacts SET normalized_name = :nn WHERE id = :id',
          { replacements: { nn: key, id: row.id }, transaction },
        );
      }

      await queryInterface.addIndex('contacts', ['household_id', 'normalized_name'], {
        unique: true,
        name: 'idx_contacts_household_normalized_name',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('contacts', 'idx_contacts_household_normalized_name');
    await queryInterface.removeColumn('contacts', 'normalized_name');
  },
};
