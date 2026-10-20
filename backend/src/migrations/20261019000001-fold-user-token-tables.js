'use strict';

/**
 * Spine fold: user_audit_tokens + user_reporting_tokens + user_capture_tokens
 * → ONE `user_tokens` table with a `scope` discriminator
 * ('audit' | 'reporting' | 'capture').
 *
 * The three tables were the same status machine (minted → used → revoked, plus
 * an optional expiry on capture) under three names; only the plaintext prefix
 * (cfa_ / cfr_ / cfc_) and the mount point differed.
 *
 * Design choice — a NEW table rather than adapting one of the old three:
 *   - The old tables are left byte-for-byte untouched (NOT dropped here), so a
 *     rollback never has to reconstruct a table, only sync rows back.
 *   - No ALTER on a populated table (SQLite would rebuild it), no renamed
 *     indexes, no sequence surgery: rows are copied with fresh ids.
 *
 * Token hashes are SHA-256 of the full plaintext (prefix included) and are
 * copied verbatim, so every existing token keeps authenticating without being
 * re-issued. Because the prefixes differ, a hash can never appear in two of
 * the old tables, so a global UNIQUE on token_hash is safe.
 *
 * Row ids are NOT preserved (each old table had its own sequence, so they
 * collide). Ids are only used by the session-authed list/revoke endpoints,
 * which re-list before revoking; bearer clients only ever hold plaintext.
 *
 * down() syncs user_tokens back into the three old tables keyed on token_hash
 * (the natural key): it updates label / last_used_at / revoked_at /
 * expires_at / updated_at on existing rows (so a post-migration revocation is
 * NOT silently undone), inserts tokens minted after the migration, then drops
 * user_tokens. A later migration drops the three legacy tables.
 */

// `expiry` is the extra column list only capture carries.
const LEGACY = [
  { scope: 'audit', table: 'user_audit_tokens', expiry: [] },
  { scope: 'reporting', table: 'user_reporting_tokens', expiry: [] },
  { scope: 'capture', table: 'user_capture_tokens', expiry: ['expires_at'] },
];

const SYNCED = ['label', 'last_used_at', 'revoked_at', 'updated_at'];

const columns = (expiry) => ['user_id', 'token_hash', 'label', 'last_used_at', 'revoked_at', ...expiry, 'created_at', 'updated_at'];

/** Copy one legacy table into user_tokens under `scope`, hashes verbatim. */
function copyLegacyRows(sequelize, { scope, table, expiry }, transaction) {
  const cols = columns(expiry).join(', ');
  return sequelize.query(
    `INSERT INTO user_tokens (scope, ${cols})
     SELECT :scope, ${cols} FROM ${table} ORDER BY id`,
    { replacements: { scope }, transaction },
  );
}

/** Carry post-migration changes (revocations, touches, relabels) back onto legacy rows by token_hash. */
function syncLegacyRows(sequelize, { scope, table, expiry }, transaction) {
  const sets = [...SYNCED, ...expiry]
    .map((c) => `${c} = (SELECT t.${c} FROM user_tokens t WHERE t.scope = :scope AND t.token_hash = ${table}.token_hash)`)
    .join(',\n           ');
  return sequelize.query(
    `UPDATE ${table}
        SET ${sets}
      WHERE token_hash IN (SELECT token_hash FROM user_tokens WHERE scope = :scope)`,
    { replacements: { scope }, transaction },
  );
}

/** Restore tokens minted after the migration into their legacy table. */
function restoreNewRows(sequelize, { scope, table, expiry }, transaction) {
  const cols = columns(expiry);
  return sequelize.query(
    `INSERT INTO ${table} (${cols.join(', ')})
     SELECT ${cols.map((c) => `t.${c}`).join(', ')}
       FROM user_tokens t
      WHERE t.scope = :scope
        AND NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.token_hash = t.token_hash)
      ORDER BY t.id`,
    { replacements: { scope }, transaction },
  );
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'user_tokens',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
          user_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          scope: { type: Sequelize.STRING(16), allowNull: false },
          token_hash: { type: Sequelize.STRING(64), allowNull: false },
          label: { type: Sequelize.STRING(64), allowNull: false },
          last_used_at: { type: Sequelize.DATE, allowNull: true },
          revoked_at: { type: Sequelize.DATE, allowNull: true },
          expires_at: { type: Sequelize.DATE, allowNull: true },
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );
      await queryInterface.addIndex('user_tokens', ['token_hash'], {
        name: 'user_tokens_token_hash_unique',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('user_tokens', ['user_id', 'scope', 'revoked_at'], {
        name: 'user_tokens_user_scope_active',
        transaction,
      });
      for (const legacy of LEGACY) {
        await copyLegacyRows(queryInterface.sequelize, legacy, transaction);
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const legacy of LEGACY) {
        await syncLegacyRows(queryInterface.sequelize, legacy, transaction);
        await restoreNewRows(queryInterface.sequelize, legacy, transaction);
      }
      await queryInterface.dropTable('user_tokens', { transaction });
    });
  },
};
