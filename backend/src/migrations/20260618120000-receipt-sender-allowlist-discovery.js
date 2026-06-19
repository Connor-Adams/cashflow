'use strict';

/** Adds discovery columns to receipt_sender_allowlist: status/source
 *  discriminators plus suggestion metadata. Existing rows backfill to
 *  status='enabled', source='user' so the fast scan's enabled filter is
 *  unaffected. Dual-dialect (SQLite + Postgres). */
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = 'receipt_sender_allowlist';
    await queryInterface.addColumn(t, 'status', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'enabled',
    });
    await queryInterface.addColumn(t, 'source', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'user',
    });
    await queryInterface.addColumn(t, 'sample_subject', {
      type: Sequelize.STRING(256),
      allowNull: true,
    });
    await queryInterface.addColumn(t, 'candidate_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn(t, 'last_seen_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    const t = 'receipt_sender_allowlist';
    await queryInterface.removeColumn(t, 'last_seen_at');
    await queryInterface.removeColumn(t, 'candidate_count');
    await queryInterface.removeColumn(t, 'sample_subject');
    await queryInterface.removeColumn(t, 'source');
    await queryInterface.removeColumn(t, 'status');
  },
};
