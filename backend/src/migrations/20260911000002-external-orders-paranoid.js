'use strict';

/**
 * docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md, Part 5.
 *
 * Adds `deleted_at` to `external_orders` and flips the ExternalOrder model to
 * `paranoid: true` (see models/ExternalOrder.ts). `mergeDuplicateAmazonOrders`
 * (src/amazon/mergeDuplicateOrders.ts) is the ONLY cron-triggered hard delete
 * in this codebase -- it runs unattended, nightly, as the first statement of
 * runAmazonMatching, and hard-deletes losing ExternalOrder rows (up to 75 on
 * the first production run). Making the model paranoid turns its existing
 * `loser.destroy()` into a soft delete automatically, without touching any of
 * the ~41 ExternalOrder query sites: Sequelize adds `deleted_at IS NULL` to
 * every one of them. A bad merge becomes recoverable with `restore()`.
 *
 * ExternalOrderItem is deliberately NOT made paranoid here -- colliding items
 * are still hard-deleted, which is correct: mergeDuplicateOrders.ts copies
 * hand-entered overrides onto the surviving twin before destroying the loser
 * item, so nothing a user typed is lost.
 *
 * Dual-dialect (SQLite + Postgres). Down drops the column (any soft-deleted
 * rows become simply indistinguishable from live ones -- there is no data to
 * lose, since nothing is ever hard-deleted once this column exists).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('external_orders', 'deleted_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('external_orders', 'deleted_at');
  },
};
