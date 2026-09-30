/**
 * Invariant checker: no NEW migration may call `removeColumn` on a queryInterface.
 *
 * On SQLite that call has no native DROP COLUMN path in Sequelize 6, so it
 * rebuilds the table from `describeTable()` output and loses every index,
 * AUTOINCREMENT, every FK action, and — worst — re-emits a COMPOSITE unique
 * index as a column-level `UNIQUE` on each member column. Use
 * `helpers/sqliteDropColumn`'s `dropColumn()` instead, which issues the native
 * `ALTER TABLE ... DROP COLUMN` (sqlite 3.35+; bundled sqlite3 is 3.44) and
 * alters in place. See that helper for the full account.
 *
 * Postgres is unaffected, which is exactly why this needs a guard rather than
 * review attention: a bad call is invisible in production and only corrupts the
 * dev/CI SQLite schema.
 */
export function callsRemoveColumnDirectly(source: string): boolean {
  // Any receiver, not just a parameter literally named `queryInterface` —
  // `qi.removeColumn(...)` is the same bug with a shorter variable.
  return /\.removeColumn\s*\(/.test(source);
}

/**
 * Migrations that still call `queryInterface.removeColumn` directly, all of them
 * predating the `dropColumn` helper. This is a debt ledger, not an exemption
 * list — entries come off it as each migration is converted, and a test asserts
 * the ledger has no stale entries so removing a call forces removing its line.
 *
 * Every one of these is in a `down()`, so none runs on a forward `db:migrate`;
 * that is why they are tolerable, not why they are correct. Rolling one back with
 * `db:migrate:undo` on SQLite still flattens the table.
 *
 * The one exception is `20260918000002-reimbursement-rate-period-source.js`,
 * whose call is already wrapped in that migration's `withIndexesPreserved`
 * shuttle and so preserves indexes (though not AUTOINCREMENT or FK actions).
 */
export const MIGRATIONS_WITH_LEGACY_REMOVE_COLUMN: readonly string[] = [
  '20250327000002-add-applied-rule-id.js',
  '20260507000001-auth-households-ownership.js',
  '20260507000002-user-global-role.js',
  '20260513000001-portfolio-imports.js',
  '20260520000002-transaction-enrichment.js',
  '20260523120001-external-order-tenders.js',
  '20260524000001-account-opening-balance.js',
  '20260524000001-receipt-item-overrides.js',
  '20260524100003-securities-metadata.js',
  '20260524180000-rule-effective-dates.js',
  '20260524210000-stable-identity-fingerprint.js',
  '20260525000001-add-split-ratio.js',
  '20260525000002-account-entity-and-tax-status.js',
  '20260525000003-transaction-entity-id.js',
  '20260526000001-security-dividend-eligibility.js',
  '20260526000002-user-dob.js',
  '20260526020100-scenarios-household-plan-id.js',
  '20260526064125-entities-spouse-entity-id.js',
  '20260526131155-entities-associated-group-id.js',
  '20260529000002-households-benchmark-symbol.js',
  '20260530000001-accounts-closed-at.js',
  '20260530000001-corporate-actions.js',
  '20260531000001-budgets-scope-rollover.js',
  '20260531120000-contacts-normalized-name.js',
  '20260602000002-budgets-exclude-refunded.js',
  '20260602110000-pdf-import-observability.js',
  '20260603000001-transaction-transfer-purpose.js',
  '20260603000001-transactions-import-confidence.js',
  '20260603000003-users-last-digest-sent-at.js',
  '20260603000007-import-batches-account-profile-counts.js',
  '20260603000010-import-histories-rollback.js',
  '20260603100020-budget-breach-alerts.js',
  '20260604100001-transactions-status.js',
  '20260605100000-transaction-counterparty.js',
  '20260606000001-contacts-is-partner.js',
  '20260606000002-cashflow-settings-exclude-non-partner-inflows.js',
  '20260606100000-cashflow-settings-counterparty-threshold.js',
  '20260607100001-cashflow-settings-large-purchase-threshold.js',
  '20260608000000-household-invites-optional-email.js',
  '20260608000005-cashflow-settings-onboarding-dismissed-at.js',
  '20260608000010-liability-accounts-cc-fields.js',
  '20260609000001-account-bank-number.js',
  '20260610000000-liability-accounts-credit-limit.js',
  '20260610000001-users-last-seen-changelog-version.js',
  '20260611000001-expectation-absorb-columns.js',
  '20260612000000-accounts-notes.js',
  '20260612000003-entity-currency.js',
  '20260612000004-cashflow-settings-dismissed-activation-cards.js',
  '20260615000001-add-tax-treatment-columns.js',
  '20260616000001-add-owner-entity-id.js',
  '20260617000001-external-order-items-display-name.js',
  '20260618100001-contact-user-link.js',
  '20260618100002-settlement-recorded-by.js',
  '20260618120000-receipt-sender-allowlist-discovery.js',
  '20260619120000-push-subscriptions.js',
  '20260620000002-costco-products-verified.js',
  '20260621000001-add-household-timezone.js',
  '20260621000001-category-tree-foundation.js',
  '20260622000001-category-id-columns.js',
  '20260623000001-add-reimbursements-from-split.js',
  '20260624000001-add-contact-aliases.js',
  '20260625000001-add-contact-is-self.js',
  '20260625100001-cashflow-settings-assumed-annual-return-rate.js',
  '20260626000001-accounts-merge-columns.js',
  '20260626000001-budget-targets-version.js',
  '20260626000001-capture-token-expiry.js',
  '20260627000001-add-label-color.js',
  '20260627000001-rule-actions.js',
  '20260627000002-add-digest-day-of-week.js',
  '20260629000001-financial-goals-version.js',
  '20260911000002-external-orders-paranoid.js',
  '20260915000001-counterparty-role-and-loan-default.js',
  '20260916000001-reimbursement-interest-rows.js',
  '20260918000001-import-history-accepted-unreconciled.js',
  '20260918000002-reimbursement-rate-period-source.js',
  '20260928000001-transaction-source-tier.js',
];
