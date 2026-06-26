'use strict';

/**
 * issue #846 — DB backstop against double-crediting a repayment.
 *
 * A repayment transaction (the incoming credit) must close AT MOST ONE
 * reimbursement claim. Without a constraint, two concurrent
 * `POST /reimbursements/:id/link-repayment` calls can both set
 * `repayment_transaction_id = T` and flip `status='received'`, so `summarize()`
 * credits the single inflow against two claims → the household sees the money
 * come back twice. SQLite (dev) serializes writers and hides this; Postgres
 * (prod) does not. See the route-level fix (tx + LOCK.UPDATE + conditional
 * UPDATE) — this index is the last-line backstop that also catches any future
 * code path that forgets the lock.
 *
 * We replace the plain btree `reimbursements_repayment_transaction_id` with a
 * PARTIAL UNIQUE index on `repayment_transaction_id WHERE NOT NULL`: unlinked
 * claims (the common case, NULL) are exempt so any number may coexist, but a
 * non-null repayment id is unique across the table. Partial indexes with a
 * `where` predicate work on both SQLite (>=3.8) and Postgres, so this is
 * dual-dialect.
 *
 * Down restores the original non-unique btree so the schema round-trips.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeIndex(
      'reimbursements',
      'reimbursements_repayment_transaction_id',
    );
    await queryInterface.addIndex('reimbursements', ['repayment_transaction_id'], {
      name: 'reimbursements_repayment_transaction_id_unique',
      unique: true,
      where: { repayment_transaction_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'reimbursements',
      'reimbursements_repayment_transaction_id_unique',
    );
    await queryInterface.addIndex('reimbursements', ['repayment_transaction_id'], {
      name: 'reimbursements_repayment_transaction_id',
    });
  },
};
