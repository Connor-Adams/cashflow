'use strict';

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. New columns (nullable first so we can backfill name_key before NOT NULL).
    await queryInterface.addColumn('categories', 'parent_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'categories', key: 'id' },
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('categories', 'name_key', {
      type: Sequelize.STRING(128),
      allowNull: true,
    });

    // 2. Backfill name_key from name.
    const [rows] = await queryInterface.sequelize.query('SELECT id, name FROM categories');
    for (const row of rows) {
      await queryInterface.sequelize.query(
        'UPDATE categories SET name_key = :key WHERE id = :id',
        { replacements: { key: normalizeName(row.name), id: row.id } },
      );
    }

    // 3. Guard: surface pre-existing case-collisions loudly before the unique index.
    const [dupes] = await queryInterface.sequelize.query(
      'SELECT household_id, name_key, COUNT(*) AS c FROM categories ' +
        'GROUP BY household_id, name_key HAVING COUNT(*) > 1',
    );
    if (dupes.length > 0) {
      throw new Error(
        'category name_key collisions must be merged before migration: ' +
          JSON.stringify(dupes),
      );
    }

    // 4. Enforce NOT NULL on name_key now that it is populated.
    // SQLite requires raw SQL for changeColumn with NOT NULL.
    const dialect = queryInterface.sequelize.options.dialect;
    if (dialect === 'sqlite') {
      await queryInterface.sequelize.query(
        'ALTER TABLE categories RENAME TO categories_old',
      );
      await queryInterface.sequelize.query(`
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          household_id INTEGER NOT NULL,
          name VARCHAR(128) NOT NULL,
          icon VARCHAR(64),
          tax_treatment VARCHAR(32) NOT NULL DEFAULT 'none',
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
          name_key VARCHAR(128) NOT NULL
        )
      `);
      await queryInterface.sequelize.query(
        'INSERT INTO categories SELECT id, household_id, name, icon, tax_treatment, created_at, updated_at, parent_id, name_key FROM categories_old',
      );
      await queryInterface.sequelize.query('DROP TABLE categories_old');
    } else {
      await queryInterface.changeColumn('categories', 'name_key', {
        type: Sequelize.STRING(128),
        allowNull: false,
      });
    }

    // 5. New partial unique indexes (DB column names; partials supported on both dialects).
    await queryInterface.addIndex('categories', ['household_id', 'parent_id', 'name_key'], {
      name: 'categories_household_parent_name_key_unique',
      unique: true,
      where: { parent_id: { [Sequelize.Op.ne]: null } },
    });
    await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
      name: 'categories_household_root_name_key_unique',
      unique: true,
      where: { parent_id: null },
    });

    // 6. Drop the old (household_id, name) unique index now the replacements exist.
    //    Name comes from the original create migration 20260524170001-categories.js.
    await queryInterface.removeIndex('categories', 'categories_household_name_unique');
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('categories', 'categories_household_parent_name_key_unique');
    await queryInterface.removeIndex('categories', 'categories_household_root_name_key_unique');
    await queryInterface.removeColumn('categories', 'name_key');
    await queryInterface.removeColumn('categories', 'parent_id');
    // Recreate the old index after columns are removed.
    await queryInterface.addIndex('categories', ['household_id', 'name'], {
      name: 'categories_household_name_unique',
      unique: true,
    });
  },
};
