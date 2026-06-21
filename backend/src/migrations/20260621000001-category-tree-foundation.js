'use strict';

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. New columns (name_key NOT NULL with scaffold default '' so existing rows pass immediately;
    //    real values are backfilled in step 2).
    await queryInterface.addColumn('categories', 'parent_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'categories', key: 'id' },
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('categories', 'name_key', {
      type: Sequelize.STRING(128),
      allowNull: false,
      // Transient scaffold default so existing rows satisfy NOT NULL at add time;
      // real values are backfilled immediately below, and the Category model's
      // beforeValidate hook always sets name_key on every future write.
      defaultValue: '',
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

    // 4. New partial unique indexes (DB column names; partials supported on both dialects).
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

    // 5. Drop the old (household_id, name) unique index now the replacements exist.
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
