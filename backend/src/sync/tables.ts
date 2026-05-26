/**
 * tables — declarative table-set for the local-first backup bundle (#239).
 *
 * Each entry names a household-scoped table that participates in the
 * backup bundle. The bundle codec (bundleFormat.ts) is generic; this
 * file is where you add new tables when the schema grows.
 *
 * Design notes for the cloud-sync follow-up (documented in
 * docs/sync.md):
 *   - Tables must be safe to round-trip via JSON. We list explicit
 *     column names rather than `*` to keep BUNDLE_SCHEMA_VERSION
 *     compatibility surfaces small.
 *   - Restore happens on a TARGET household — the bundle's
 *     household_id is rewritten on import. Rows whose foreign keys
 *     cross household boundaries (e.g. contact_id on transactions)
 *     are remapped through an id-translation table built during
 *     restore.
 *   - V1 deliberately excludes receipt blobs, AI suggestions,
 *     analytic snapshots, jobs, sessions, notifications, and audit
 *     history. The receipt METADATA is NOT in V1 (no transactions
 *     reference receipts yet that V1 promises to round-trip).
 *
 * Adding a table: append to TABLES below and bump
 * BUNDLE_SCHEMA_VERSION in bundleFormat.ts so older code refuses to
 * read newer bundles.
 */

/** One table participates in the backup bundle. */
export interface BundleTableSpec {
  /** Physical table name (snake_case, matches the migrations). */
  table: string;
  /** Column names included in the dump. Use snake_case here — that's
   *  what the raw query returns and what we INSERT back on restore. */
  columns: string[];
  /** When restoring, the bundle's `household_id` column gets rewritten
   *  to the target household id. Set false on tables whose `id` is
   *  THE household id (households table). */
  rewriteHouseholdId?: boolean;
}

/**
 * V1 table set. Order matters for restore: parents come before
 * children to keep the (manual, no-FK) restore stream consistent
 * with the schema's referential integrity. Tables not listed here
 * are explicitly out of scope for V1.
 */
export const TABLES: BundleTableSpec[] = [
  {
    table: 'contacts',
    columns: [
      'id',
      'household_id',
      'name',
      'notes',
      'created_at',
      'updated_at',
    ],
    rewriteHouseholdId: true,
  },
  {
    table: 'categories',
    columns: [
      'id',
      'household_id',
      'name',
      'icon',
      'created_at',
      'updated_at',
    ],
    rewriteHouseholdId: true,
  },
  {
    table: 'accounts',
    columns: [
      'id',
      'name',
      'owner',
      'household_id',
      'owner_user_id',
      'visibility',
      'account_type',
      'short_code',
      'default_currency',
      'entity_id',
      'tax_status',
      'opening_balance',
      'opening_balance_date',
      'closed_at',
      'created_at',
      'updated_at',
    ],
    rewriteHouseholdId: true,
  },
  {
    table: 'rules',
    columns: [
      'id',
      'merchant_pattern',
      'household_id',
      'created_by_user_id',
      'match_kind',
      'priority',
      'category',
      'is_business',
      'split_type',
      'pct_me',
      'pct_partner',
      'effective_from',
      'effective_to',
      'created_at',
      'updated_at',
    ],
    rewriteHouseholdId: true,
  },
  {
    table: 'transactions',
    columns: [
      'id',
      'account_id',
      'household_id',
      'created_by_user_id',
      'visibility',
      'ownership_type',
      'ownership_contact_id',
      'import_batch',
      'date',
      'merchant_raw',
      'merchant_clean',
      'amount',
      'currency',
      'notes',
      'source_reference',
      'source_row_fingerprint',
      'source_identity_fingerprint',
      'status',
      'applied_rule_id',
      'entity_id',
      'auto_category',
      'category_override',
      'final_category',
      'auto_business',
      'business_override',
      'final_business',
      'auto_split_type',
      'split_override',
      'final_split_type',
      'auto_pct_me',
      'pct_me_override',
      'final_pct_me',
      'auto_pct_partner',
      'pct_partner_override',
      'final_pct_partner',
      'my_share_amount',
      'partner_share_amount',
      'business_amount',
      'merchant_canonical',
      'txn_type',
      'auto_source',
      'auto_confidence',
      'linked_transaction_id',
      'transfer_purpose',
      'transfer_linked_at',
      'is_recurring',
      'review_flag',
      'reviewed_at',
      'import_confidence',
      'import_confidence_flags',
      'created_at',
      'updated_at',
    ],
    rewriteHouseholdId: true,
  },
];

/** Allow-list for restore — refuse any incoming table not in TABLES. */
export const TABLE_NAMES: ReadonlySet<string> = new Set(TABLES.map((t) => t.table));
