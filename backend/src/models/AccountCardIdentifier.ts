import {
  Model,
  DataTypes,
  type Sequelize,
  type Transaction,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * AccountCardIdentifier (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md).
 *
 * A child table on Account: an Account may have MANY card last-4s. Today
 * `accounts.short_code` is the only place a last-4 lives, and it is already
 * an import key (`runImport.ts` keys account lookup on it) -- which is why
 * Costco MC's short_code is the literal string `'costco'` (the token its
 * import files match on) rather than its real card, `3114`. This table lets
 * a card last-4 be recorded without overloading short_code.
 *
 * `source` names which parser produced the sighting and is load-bearing for
 * harvesting: only deterministic parsers (PDF statement headers, receipt
 * tenders) are trusted, never AI extraction -- see the design doc's "source
 * filter that makes this safe" (an AI misparse produced a wrong last4 in
 * production; a regex over parsed document text never has).
 *
 * Uniqueness: UNIQUE(account_id, last4) -- re-harvesting the same card is
 * idempotent via `upsertAccountCardIdentifier` below. A last4 may map to more
 * than one account (`buildLast4Map` in `cardOwnership.ts` already returns
 * `Map<string, number[]>`), so there is no uniqueness on last4 alone.
 */
export class AccountCardIdentifier extends Model<
  InferAttributes<AccountCardIdentifier>,
  InferCreationAttributes<AccountCardIdentifier>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare accountId: number;
  declare last4: string;
  declare source: string;
  declare firstSeenAt: Date;
  declare lastSeenAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAccountCardIdentifier(sequelize: Sequelize): typeof AccountCardIdentifier {
  AccountCardIdentifier.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      accountId: { type: DataTypes.INTEGER, field: 'account_id', allowNull: false },
      last4: {
        type: DataTypes.STRING(4),
        allowNull: false,
        validate: {
          is: {
            args: /^\d{4}$/,
            msg: 'last4 must be exactly 4 digits',
          },
        },
      },
      source: { type: DataTypes.STRING(64), allowNull: false },
      firstSeenAt: { type: DataTypes.DATE, field: 'first_seen_at', allowNull: false },
      lastSeenAt: { type: DataTypes.DATE, field: 'last_seen_at', allowNull: false },
    } as ModelAttributes<AccountCardIdentifier>,
    {
      sequelize,
      modelName: 'AccountCardIdentifier',
      tableName: 'account_card_identifiers',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ['account_id', 'last4'],
          name: 'account_card_identifiers_account_last4',
        },
        { fields: ['household_id'], name: 'account_card_identifiers_household_id' },
        { fields: ['last4'], name: 'account_card_identifiers_last4' },
      ],
    },
  );
  return AccountCardIdentifier;
}

/**
 * Idempotent upsert on (accountId, last4): a repeat sighting of the same
 * card never duplicates the row -- it refreshes `lastSeenAt` (and the stored
 * `source`, since source describes the most recent confirmation rather than
 * a provenance history) while leaving `firstSeenAt` untouched.
 */
export async function upsertAccountCardIdentifier(args: {
  householdId: number;
  accountId: number;
  last4: string;
  source: string;
  seenAt?: Date;
  transaction?: Transaction;
}): Promise<AccountCardIdentifier> {
  const seenAt = args.seenAt ?? new Date();
  const existing = await AccountCardIdentifier.findOne({
    where: { accountId: args.accountId, last4: args.last4 },
    transaction: args.transaction,
  });
  if (existing) {
    await existing.update(
      { lastSeenAt: seenAt, source: args.source },
      { transaction: args.transaction },
    );
    return existing;
  }
  return AccountCardIdentifier.create(
    {
      householdId: args.householdId,
      accountId: args.accountId,
      last4: args.last4,
      source: args.source,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    },
    { transaction: args.transaction },
  );
}

/**
 * Every harvested last4 for a household, grouped by account id -- ONE query,
 * never per-account. Feeds `resolveAccountLast4s`/`buildLast4Map`
 * (backend/src/amazon/cardOwnership.ts) at the hot dashboard/budget call
 * sites (items.ts, receipts.ts, loadItemAllocations.ts, amazon/matcher.ts) so
 * they widen beyond `short_code` without adding a query per account.
 */
export async function loadIdentifierLast4sByAccountId(
  householdId: number,
): Promise<Map<number, string[]>> {
  const rows = await AccountCardIdentifier.findAll({
    where: { householdId },
    attributes: ['accountId', 'last4'],
  });
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.accountId) ?? [];
    list.push(row.last4);
    map.set(row.accountId, list);
  }
  return map;
}
