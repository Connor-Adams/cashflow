import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * SimplefinAccountLink (issue #813) — the explicit, persisted mapping from a
 * discovered SimpleFIN account (`simplefinAccountId`, stable per access URL) to
 * a Cashflow `Account`, scoped to the owning `UserSimplefinIntegration`.
 *
 * This is NOT a new primitive: it is a child/relation table on the SimpleFIN
 * integration credential-store (itself a folded import SOURCE onto the
 * Account/Transaction primitives). It replaces the previous implicit,
 * household-wide name re-derivation in sync.ts with a single source of truth.
 *
 * Uniqueness (enforced at the DB layer, see the migration):
 *   - UNIQUE (integration_id, simplefin_account_id) — one link per discovered
 *     account per integration (idempotent re-discovery; powers upsert).
 *   - UNIQUE (account_id) — a Cashflow Account is the target of EXACTLY ONE
 *     SimpleFIN link across all integrations. This is the guard that makes a
 *     shared/joint account un-double-importable and blocks cross-member writes.
 */
export class SimplefinAccountLink extends Model<
  InferAttributes<SimplefinAccountLink>,
  InferCreationAttributes<SimplefinAccountLink>
> {
  declare id: CreationOptional<number>;
  declare integrationId: number;
  declare simplefinAccountId: string;
  declare accountId: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSimplefinAccountLink(
  sequelize: Sequelize,
): typeof SimplefinAccountLink {
  SimplefinAccountLink.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      integrationId: {
        type: DataTypes.INTEGER,
        field: 'integration_id',
        allowNull: false,
      },
      simplefinAccountId: {
        type: DataTypes.STRING(255),
        field: 'simplefin_account_id',
        allowNull: false,
      },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
        unique: true,
      },
    } as ModelAttributes<SimplefinAccountLink>,
    {
      sequelize,
      modelName: 'SimplefinAccountLink',
      tableName: 'simplefin_account_links',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ['integration_id', 'simplefin_account_id'],
          name: 'simplefin_account_links_integration_account',
        },
        { fields: ['integration_id'], name: 'simplefin_account_links_integration_id' },
      ],
    },
  );
  return SimplefinAccountLink;
}
