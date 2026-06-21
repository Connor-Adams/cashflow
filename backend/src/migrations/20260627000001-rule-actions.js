'use strict';

/**
 * Generalize Rule effects into a composable `actions` list (issue #795).
 *
 * Forward:
 *   1. Add `rules.actions` — JSON, NOT NULL, default `[]`. JSON works on both
 *      SQLite (dev/unit) and Postgres (prod/integration), matching the
 *      precedent set by `notifications.data_json`.
 *   2. For every existing row, derive the equivalent actions array from the
 *      scalar effect columns and write it back. The derivation mirrors
 *      `deriveActionsFromScalars` in backend/src/rules/actions.ts (kept in
 *      lockstep — this file can't import the TS module):
 *        - push `set_category` when `category` is non-null,
 *        - push `set_business` when `is_business` is truthy,
 *        - push `set_split` when `split_type` is anything other than the
 *          default `me` OR a split percentage is set.
 *      Rows are selected, JSON-encoded in JS, and updated one-by-one with
 *      parameterised SQL — no Postgres-only JSON functions, so it runs verbatim
 *      on SQLite.
 *
 * Backward: drop the `actions` column. NO DATA LOSS — the scalar columns
 * (`category`, `is_business`, `split_type`, `pct_me`, `pct_partner`) are never
 * removed and remain the source of truth for the legacy effects, so a rollback
 * degrades cleanly to pre-#795 behavior.
 */

/** Mirror of deriveActionsFromScalars (backend/src/rules/actions.ts). */
function deriveActionsFromScalars(row) {
  const actions = [];
  const category = row.category != null ? row.category : null;
  const isBusiness = row.is_business === true || row.is_business === 1;
  const splitType = row.split_type != null ? row.split_type : 'me';
  const pctMe = row.pct_me != null ? String(row.pct_me) : null;
  const pctPartner = row.pct_partner != null ? String(row.pct_partner) : null;

  if (category != null) {
    actions.push({ type: 'set_category', payload: { category } });
  }
  if (isBusiness) {
    actions.push({ type: 'set_business', payload: { isBusiness: true } });
  }
  const hasSplit = splitType !== 'me' || pctMe != null || pctPartner != null;
  if (hasSplit) {
    actions.push({ type: 'set_split', payload: { splitType, pctMe, pctPartner } });
  }
  return actions;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('rules', 'actions', {
      type: Sequelize.JSON,
      allowNull: false,
      defaultValue: [],
    });

    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (t) => {
      const [rows] = await sequelize.query(
        `SELECT id, category, is_business, split_type, pct_me, pct_partner FROM rules`,
        { transaction: t },
      );
      let updated = 0;
      for (const row of rows) {
        const actions = deriveActionsFromScalars(row);
        await sequelize.query(`UPDATE rules SET actions = ? WHERE id = ?`, {
          replacements: [JSON.stringify(actions), row.id],
          transaction: t,
        });
        updated++;
      }
      // eslint-disable-next-line no-console
      console.log(`[rule-actions] derived actions for ${updated} existing rule(s)`);
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('rules', 'actions');
  },
};
