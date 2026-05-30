'use strict';

/**
 * Reimbursement tracker (issue #216). Each row records money the household
 * expects back for an original outlay transaction — from a partner, friend,
 * employer, insurer, etc. Unlike the 1:1 sidecar tables (purchases,
 * transaction_return_metadata) this table has its OWN integer PK because a
 * single transaction can spawn multiple reimbursement claims (e.g. an expense
 * split across two people), so the relationship to `transactions` is 1:N.
 *
 * Party can be either a structured Contact (`contact_id`) OR free text
 * (`party_name`) — routes require at least one. `repayment_transaction_id`
 * points at the incoming credit transaction once a repayment is matched.
 *
 * `status` is stored as STRING(16) (not a native enum) so the vocab can grow
 * without a destructive migration:
 *   'expected' — open, awaiting repayment (default)
 *   'received' — repayment matched/closed
 *   'overdue'  — explicitly pinned overdue (a derived "overdue" view also
 *                exists: status='expected' AND due_date < today, computed in
 *                the serializer so no cron is needed)
 *   'waived'   — forgiven / written off
 *
 * FK delete semantics:
 *   transaction_id           CASCADE  — claim is meaningless without its outlay
 *   household_id             CASCADE  — household teardown removes its data
 *   contact_id               SET NULL — keep claim, drop structured party ref
 *   repayment_transaction_id SET NULL — keep claim, just un-match the repayment
 *   created_by_user_id       SET NULL — keep claim if the creator is removed
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reimbursements', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      household_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'households', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      contact_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'contacts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      party_name: {
        type: Sequelize.STRING(160),
        allowNull: true,
      },
      amount: {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      due_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'expected',
      },
      repayment_transaction_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'transactions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      received_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('reimbursements', ['household_id'], {
      name: 'reimbursements_household_id',
    });
    await queryInterface.addIndex('reimbursements', ['transaction_id'], {
      name: 'reimbursements_transaction_id',
    });
    await queryInterface.addIndex('reimbursements', ['contact_id'], {
      name: 'reimbursements_contact_id',
    });
    await queryInterface.addIndex('reimbursements', ['status'], {
      name: 'reimbursements_status',
    });
    await queryInterface.addIndex('reimbursements', ['due_date'], {
      name: 'reimbursements_due_date',
    });
    await queryInterface.addIndex('reimbursements', ['repayment_transaction_id'], {
      name: 'reimbursements_repayment_transaction_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'reimbursements',
      'reimbursements_repayment_transaction_id',
    );
    await queryInterface.removeIndex('reimbursements', 'reimbursements_due_date');
    await queryInterface.removeIndex('reimbursements', 'reimbursements_status');
    await queryInterface.removeIndex('reimbursements', 'reimbursements_contact_id');
    await queryInterface.removeIndex(
      'reimbursements',
      'reimbursements_transaction_id',
    );
    await queryInterface.removeIndex(
      'reimbursements',
      'reimbursements_household_id',
    );
    await queryInterface.dropTable('reimbursements');
  },
};
