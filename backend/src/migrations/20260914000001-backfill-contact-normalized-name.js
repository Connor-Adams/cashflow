'use strict';

/**
 * Re-derives contacts.normalized_name from contacts.name.
 *
 * Why rows drifted: `Contact.beforeValidate` sets normalizedName, but
 * Sequelize's `instance.save()` snapshots `options.fields` from `this.changed()`
 * BEFORE hooks run, so the derived column was dropped from the emitted UPDATE.
 * Renaming a contact persisted `name` and left the old `normalized_name`
 * behind. The model hook now pushes the field onto `options.fields`; this
 * migration repairs the rows written before that fix.
 *
 * Consequences of the drift this repairs: the transfer-link matcher reads
 * `normalizedName ?? normalizeContactName(name)`, so a renamed contact kept
 * matching on its old (usually first-name-only) key; and the unique
 * (household_id, normalized_name) dedup index no longer reflected the visible
 * name, so a new contact typed with the full name would not collide with the
 * existing one.
 */
// Inlined to keep the migration self-contained (mirrors src/contacts/normalizeContactName.ts).
function normalize(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id, household_id, name, normalized_name FROM contacts ORDER BY id ASC',
        { transaction },
      );

      // Same disambiguation contract as 20260531120000-contacts-normalized-name:
      // within a household the oldest id keeps the base key and later
      // collisions get a `#<id>` suffix, bounded to the STRING(160) column.
      const takenByHousehold = new Map();
      const changes = [];
      for (const row of rows) {
        const base = normalize(row.name) || `contact-${row.id}`;
        let taken = takenByHousehold.get(row.household_id);
        if (!taken) { taken = new Set(); takenByHousehold.set(row.household_id, taken); }
        let key = base;
        if (taken.has(key)) {
          const suffix = `#${row.id}`;
          key = `${base.slice(0, 160 - suffix.length)}${suffix}`;
        }
        taken.add(key);
        if (key !== row.normalized_name) changes.push({ id: row.id, key });
      }
      if (changes.length === 0) return;

      // Two passes: clear every key we are about to rewrite, then write the new
      // ones. A single pass can transiently violate the unique index when two
      // rows swap keys. NULLs are distinct in unique indexes on PG + SQLite.
      for (const { id } of changes) {
        await queryInterface.sequelize.query(
          'UPDATE contacts SET normalized_name = NULL WHERE id = :id',
          { replacements: { id }, transaction },
        );
      }
      for (const { id, key } of changes) {
        await queryInterface.sequelize.query(
          'UPDATE contacts SET normalized_name = :nn WHERE id = :id',
          { replacements: { nn: key, id }, transaction },
        );
      }
    });
  },

  async down() {
    // No-op. The pre-migration values were stale keys that no longer matched
    // their contact's name; restoring them would reintroduce the mismatch the
    // model hook now prevents, and they are not recoverable from the schema.
  },
};
