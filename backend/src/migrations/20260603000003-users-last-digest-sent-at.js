'use strict';

/**
 * Weekly digest scheduler bookkeeping (issue #267).
 *
 * Adds `users.last_digest_sent_at TIMESTAMP NULL DEFAULT NULL` so the
 * weekly-digest cron can answer the "is this user due?" question without a
 * per-user side table. NULL means "never sent" and counts as eligible.
 *
 * Indexed because the eligibility query is essentially:
 *   SELECT id FROM users
 *   WHERE last_digest_sent_at IS NULL
 *      OR last_digest_sent_at < (now() - INTERVAL '6 days')
 * which would otherwise full-scan `users`. A plain b-tree index over a
 * nullable timestamp column covers both branches (sqlite + postgres both
 * include NULLs in the index by default).
 *
 * Reversible: down drops the index then the column. Tests round-trip this
 * forward-then-backward to guarantee future contributors can roll back.
 */

async function addIndex(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (e) {
    if (!String(e && e.message).includes('already exists')) throw e;
  }
}

async function removeIndex(queryInterface, table, name) {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (e) {
    if (!String(e && e.message).includes("doesn't exist")) {
      if (!/no such index/i.test(String(e && e.message))) throw e;
    }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'last_digest_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await addIndex(queryInterface, 'users', ['last_digest_sent_at'], {
      name: 'users_last_digest_sent_at',
    });
  },

  async down(queryInterface) {
    await removeIndex(queryInterface, 'users', 'users_last_digest_sent_at');
    await queryInterface.removeColumn('users', 'last_digest_sent_at');
  },
};
