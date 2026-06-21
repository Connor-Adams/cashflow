'use strict';

/**
 * issue #813 — explicit per-integration SimpleFIN account mapping.
 *
 * Creates `simplefin_account_links`: the persisted mapping from a discovered
 * SimpleFIN account (`simplefin_account_id`) to a Cashflow `Account`, scoped to
 * the owning integration. This replaces the household-wide name re-derivation in
 * sync.ts as the single source of truth for which Account a remote account
 * imports into.
 *
 * Indexes / uniqueness:
 *   - UNIQUE (integration_id, simplefin_account_id) — one link per discovered
 *     account per integration (idempotent re-discovery; powers upsert).
 *   - UNIQUE (account_id) — a Cashflow Account is the target of EXACTLY ONE link
 *     across all integrations (un-double-imports a shared/joint account and
 *     blocks cross-member ownership).
 *   - non-unique (integration_id) for the list/sync lookup.
 *
 * NOTE: the UNIQUE(user_id) index on `user_simplefin_integrations` already
 * exists (migration 20260619000001) — this migration does NOT re-add it.
 *
 * Backfill: for each integration, replay #790's resolution (last-4 then
 * unambiguous normalized-name match against the user's household accounts) and
 * insert a link for every unambiguous pair whose account_id isn't already
 * claimed by an earlier link (first-writer-wins, mirroring UNIQUE(account_id)).
 * Ambiguous / already-claimed pairs are skipped — they surface in the UI as
 * unlinked. Discovery is NOT re-run here (no network in a migration); we resolve
 * against the *remote names already imported as Account names*, which is the
 * exact signal sync.ts used. There is no stored discovery payload, so the
 * backfill matches on the household accounts whose names/numbers the old
 * heuristic would have linked — i.e. it links each integration's user's own
 * household accounts by name. This is best-effort and conservative; anything it
 * skips is recoverable via the new link UI.
 *
 * Dual-dialect (SQLite + Postgres). Down drops the table; it does NOT restore
 * any rows (there are none to lose — the table is new).
 */

function norm(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('simplefin_account_links', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      integration_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'user_simplefin_integrations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      simplefin_account_id: { type: Sequelize.STRING(255), allowNull: false },
      account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'accounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(
      'simplefin_account_links',
      ['integration_id', 'simplefin_account_id'],
      { unique: true, name: 'simplefin_account_links_integration_account' },
    );
    await queryInterface.addIndex('simplefin_account_links', ['account_id'], {
      unique: true,
      name: 'simplefin_account_links_account_id',
    });
    await queryInterface.addIndex('simplefin_account_links', ['integration_id'], {
      name: 'simplefin_account_links_integration_id',
    });

    // ---- Backfill -----------------------------------------------------------
    // The SimpleFIN discovery payload is not persisted, so we cannot replay
    // last-4 matching against remote account numbers in a migration. What sync.ts
    // actually used is an unambiguous match between the remote NAME and the
    // household Account NAME. We reproduce that conservatively: for each
    // integration, link its user's own household accounts where a name occurs
    // exactly once in that household (first-writer-wins on account_id across all
    // integrations). The simplefin_account_id is set to the account name as a
    // placeholder remote id; the live link UI will reconcile it on next use, and
    // sync resolves by account_id regardless. This keeps any account that #790
    // would have auto-linked importing without manual relinking.
    const now = new Date();
    const [integrations] = await queryInterface.sequelize.query(
      `SELECT i.id AS integration_id, m.household_id AS household_id
         FROM user_simplefin_integrations i
         LEFT JOIN household_members m ON m.user_id = i.user_id
        WHERE i.status <> 'disconnected'`,
    );

    const claimedAccountIds = new Set();
    for (const integ of integrations) {
      if (integ.household_id == null) continue;
      const [accounts] = await queryInterface.sequelize.query(
        `SELECT id, name FROM accounts
          WHERE household_id = ${Number(integ.household_id)}
            AND merged_into_id IS NULL`,
      );
      // Count names within the household to keep only unambiguous ones.
      const byName = new Map();
      for (const a of accounts) {
        const key = norm(a.name);
        if (!key) continue;
        const list = byName.get(key) || [];
        list.push(a);
        byName.set(key, list);
      }
      for (const a of accounts) {
        const key = norm(a.name);
        if (!key) continue;
        if ((byName.get(key) || []).length !== 1) continue; // ambiguous
        if (claimedAccountIds.has(a.id)) continue; // first-writer-wins
        claimedAccountIds.add(a.id);
        await queryInterface.bulkInsert('simplefin_account_links', [
          {
            integration_id: integ.integration_id,
            simplefin_account_id: String(a.name),
            account_id: a.id,
            created_at: now,
            updated_at: now,
          },
        ]);
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'simplefin_account_links',
      'simplefin_account_links_integration_id',
    );
    await queryInterface.removeIndex(
      'simplefin_account_links',
      'simplefin_account_links_account_id',
    );
    await queryInterface.removeIndex(
      'simplefin_account_links',
      'simplefin_account_links_integration_account',
    );
    await queryInterface.dropTable('simplefin_account_links');
  },
};
