'use strict';

// One-shot cleanup: collapse duplicate `financial_insight` AiSuggestion rows.
// Per (household_id, period, currency) group, keep only the row with MAX(id)
// in status='suggested'; mark the rest 'superseded'. Idempotent — re-running
// against a clean table is a no-op.

module.exports = {
  async up(queryInterface) {
    const dialect = queryInterface.sequelize.getDialect();
    const periodExpr =
      dialect === 'postgres'
        ? "input_snapshot ->> 'period'"
        : "json_extract(input_snapshot, '$.period')";
    const currencyExpr =
      dialect === 'postgres'
        ? "input_snapshot ->> 'currency'"
        : "json_extract(input_snapshot, '$.currency')";
    const nowExpr = dialect === 'postgres' ? 'NOW()' : "datetime('now')";

    await queryInterface.sequelize.query(
      `UPDATE ai_suggestions
       SET status = 'superseded', updated_at = ${nowExpr}
       WHERE kind = 'financial_insight'
         AND status = 'suggested'
         AND id NOT IN (
           SELECT MAX(id) FROM ai_suggestions
           WHERE kind = 'financial_insight' AND status = 'suggested'
           GROUP BY household_id, ${periodExpr}, ${currencyExpr}
         );`,
    );
  },

  async down() {
    // Irreversible cleanup. No-op on rollback.
  },
};
