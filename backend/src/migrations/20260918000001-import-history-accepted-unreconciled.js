'use strict';

/**
 * `import_histories.accepted_unreconciled` — the audit stamp for a deliberate
 * reconciliation-gate override.
 *
 * Statement parsers that can recompute a closing balance push a blocking
 * parse error when the recomputed figure disagrees with the printed one; the
 * commit path now refuses those imports. A caller who has inspected the
 * statement and wants it anyway passes `acceptUnreconciled: true`, and this
 * column is how that decision stays findable after the fact (the gate's
 * verdict itself is written into `error_message`).
 *
 * Spine note: no new primitive, no new table — `ImportHistory` is already the
 * batch record for the import machine; this is one more fact about a batch.
 *
 * NOT NULL DEFAULT false backfills every existing row in one statement:
 * nothing imported before this migration went through an override.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('import_histories', 'accepted_unreconciled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('import_histories', 'accepted_unreconciled');
  },
};
