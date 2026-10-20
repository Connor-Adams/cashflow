'use strict';

/**
 * Drop five tables no code reads or writes any more.
 *
 *   ai_review_runs, cfo_briefings
 *     The AI review and CFO briefing features were removed end to end (#1206).
 *     Their models stayed registered only so household erasure kept cascading
 *     over the leftover rows; those rows are dropped here with the tables.
 *
 *   user_audit_tokens, user_reporting_tokens, user_capture_tokens
 *     Folded into `user_tokens` (scope discriminator) by
 *     20261019000001-fold-user-token-tables, which copied every row with its
 *     token_hash verbatim. The models were deleted in the same change.
 *
 * DROP TABLE takes each table's indexes, FK constraints and id sequence with
 * it. Nothing references these tables (no inbound FKs, no views).
 *
 * Guard: before dropping a legacy token table, up() refuses to run if any of
 * its rows has a token_hash missing from user_tokens. Such a row would be a
 * token the fold never carried over, and dropping it would silently revoke it.
 *
 * IRREVERSIBLE FOR DATA. down() recreates all five tables with the exact schema
 * they had (original create migrations plus the later capture-token
 * `expires_at` column), but EMPTY: the dropped rows are gone. That is enough
 * for the fold migration's own down() to run next: it repopulates the three
 * legacy token tables from user_tokens by token_hash, so undoing both
 * migrations in order still lands every token back where it was.
 */

const RETIRED_FEATURE_TABLES = ['ai_review_runs', 'cfo_briefings'];

const LEGACY_TOKEN_TABLES = [
  { table: 'user_audit_tokens', expiry: false },
  { table: 'user_reporting_tokens', expiry: false },
  { table: 'user_capture_tokens', expiry: true },
];

/** Columns shared by ai_review_runs (#210) and cfo_briefings (#236). */
function reviewColumns(Sequelize, { safeToSpend }) {
  return {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'households', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    period_start: { type: Sequelize.DATEONLY, allowNull: false },
    period_end: { type: Sequelize.DATEONLY, allowNull: false },
    currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'CAD' },
    status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'completed' },
    summary: { type: Sequelize.TEXT, allowNull: true },
    action_items: { type: Sequelize.JSON, allowNull: false, defaultValue: [] },
    ...(safeToSpend ? { safe_to_spend_snapshot: { type: Sequelize.JSON, allowNull: true } } : {}),
    model: { type: Sequelize.STRING(128), allowNull: true },
    prompt_version: { type: Sequelize.STRING(64), allowNull: true },
    error_message: { type: Sequelize.TEXT, allowNull: true },
    created_at: { type: Sequelize.DATE, allowNull: false },
    updated_at: { type: Sequelize.DATE, allowNull: false },
  };
}

/** Columns of the three legacy token tables; capture gained expires_at last (#829). */
function tokenColumns(Sequelize, { expiry }) {
  return {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    token_hash: { type: Sequelize.STRING(64), allowNull: false },
    label: { type: Sequelize.STRING(64), allowNull: false },
    last_used_at: { type: Sequelize.DATE, allowNull: true },
    revoked_at: { type: Sequelize.DATE, allowNull: true },
    created_at: { type: Sequelize.DATE, allowNull: false },
    updated_at: { type: Sequelize.DATE, allowNull: false },
    ...(expiry ? { expires_at: { type: Sequelize.DATE, allowNull: true } } : {}),
  };
}

async function assertFolded(sequelize, table, transaction) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM ${table} o
      WHERE NOT EXISTS (SELECT 1 FROM user_tokens t WHERE t.token_hash = o.token_hash)`,
    { transaction },
  );
  const missing = Number(rows[0].n);
  if (missing > 0) {
    throw new Error(
      `${table}: ${missing} row(s) have no matching token_hash in user_tokens; refusing to drop`,
    );
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const { table } of LEGACY_TOKEN_TABLES) {
        await assertFolded(queryInterface.sequelize, table, transaction);
      }
      for (const table of RETIRED_FEATURE_TABLES) {
        await queryInterface.dropTable(table, { transaction });
      }
      for (const { table } of LEGACY_TOKEN_TABLES) {
        await queryInterface.dropTable(table, { transaction });
      }
    });
  },

  // Schema only, no data: see the header.
  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const table of RETIRED_FEATURE_TABLES) {
        await queryInterface.createTable(
          table,
          reviewColumns(Sequelize, { safeToSpend: table === 'cfo_briefings' }),
          { transaction },
        );
        await queryInterface.addIndex(table, ['household_id'], { name: `${table}_household_id`, transaction });
        await queryInterface.addIndex(table, ['user_id'], { name: `${table}_user_id`, transaction });
        await queryInterface.addIndex(table, ['household_id', 'period_start'], {
          name: `${table}_household_period_start`,
          transaction,
        });
        await queryInterface.addIndex(table, ['household_id', 'created_at'], {
          name: `${table}_household_created_at`,
          transaction,
        });
      }
      for (const { table, expiry } of LEGACY_TOKEN_TABLES) {
        await queryInterface.createTable(table, tokenColumns(Sequelize, { expiry }), { transaction });
        await queryInterface.addIndex(table, ['token_hash'], {
          name: `${table}_token_hash_unique`,
          unique: true,
          transaction,
        });
        await queryInterface.addIndex(table, ['user_id', 'revoked_at'], {
          name: `${table}_user_active`,
          transaction,
        });
      }
    });
  },
};
