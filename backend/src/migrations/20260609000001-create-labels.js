'use strict';

/**
 * Transaction labels and tags (issue #270).
 *
 * Two tables:
 *  - `labels`: one row per household-scoped free-text label (max 32 chars).
 *    Case-insensitive uniqueness per household is enforced by a functional
 *    UNIQUE index on (household_id, LOWER(name)) so "Tax-Deductible" and
 *    "tax-deductible" collide (AC #2). Both sqlite and Postgres support the
 *    `LOWER(name)` index expression, so one raw CREATE UNIQUE INDEX covers
 *    both dialects.
 *  - `transaction_labels`: the join table. Composite PK (transaction_id,
 *    label_id) makes a (txn, label) pair idempotent — re-applying a label is a
 *    no-op insert conflict, never a duplicate row (AC #6). FKs cascade so
 *    deleting a transaction or a label removes its join rows (AC #9).
 *
 * Scope note: the issue body specifies `user_id`, but Cashflow scopes all
 * user-data tables (categories, contacts, budget_targets, tax_tags, …) by
 * `household_id`. We follow that convention here so labels are shared within a
 * household, matching every sibling feature.
 */

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {typeof import('sequelize').Sequelize} Sequelize */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('labels', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await addIndex(queryInterface, 'labels', ['household_id'], {
      name: 'labels_household_id',
    });

    // Case-insensitive uniqueness per household. addIndex cannot express a
    // function over a column, so use raw SQL. The expression form is identical
    // on sqlite and Postgres.
    try {
      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX labels_household_lower_name_unique ' +
          'ON labels (household_id, LOWER(name))',
      );
    } catch (e) {
      if (!String(e && e.message).includes('already exists')) throw e;
    }

    await queryInterface.createTable('transaction_labels', {
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      label_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
        references: { model: 'labels', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    // Label-first composite index powers "all transactions with label X"
    // (the ?labels= any-of filter, AC #7).
    await addIndex(queryInterface, 'transaction_labels', ['label_id', 'transaction_id'], {
      name: 'transaction_labels_label_txn',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('transaction_labels');
    await queryInterface.dropTable('labels');
  },
};
