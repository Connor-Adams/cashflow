import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class HoldingSnapshot extends Model<
  InferAttributes<HoldingSnapshot>,
  InferCreationAttributes<HoldingSnapshot>
> {
  declare id: CreationOptional<number>;
  declare accountId: number;
  declare householdId: number | null;
  declare securityId: number;
  declare statementDate: string;
  declare quantity: string;
  declare price: string | null;
  declare marketValue: string | null;
  declare costBasis: string | null;
  declare unrealizedGainLoss: string | null;
  declare currency: string;
  declare sourceReference: string | null;
  declare sourceRowFingerprint: string;
  declare importBatch: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHoldingSnapshot(sequelize: Sequelize): typeof HoldingSnapshot {
  HoldingSnapshot.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      accountId: {
        type: DataTypes.INTEGER,
        field: 'account_id',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      securityId: {
        type: DataTypes.INTEGER,
        field: 'security_id',
        allowNull: false,
      },
      statementDate: {
        type: DataTypes.DATEONLY,
        field: 'statement_date',
        allowNull: false,
      },
      quantity: { type: DataTypes.DECIMAL(20, 8), allowNull: false },
      price: { type: DataTypes.DECIMAL(20, 8), allowNull: true },
      marketValue: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'market_value',
        allowNull: true,
      },
      costBasis: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'cost_basis',
        allowNull: true,
      },
      unrealizedGainLoss: {
        type: DataTypes.DECIMAL(14, 4),
        field: 'unrealized_gain_loss',
        allowNull: true,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      sourceReference: {
        type: DataTypes.STRING(256),
        field: 'source_reference',
        allowNull: true,
      },
      sourceRowFingerprint: {
        type: DataTypes.STRING(128),
        field: 'source_row_fingerprint',
        allowNull: false,
      },
      importBatch: {
        type: DataTypes.STRING(128),
        field: 'import_batch',
        allowNull: false,
      },
    } as ModelAttributes<HoldingSnapshot>,
    {
      sequelize,
      modelName: 'HoldingSnapshot',
      tableName: 'holdings_snapshots',
      underscored: true,
      timestamps: true,
    }
  );
  return HoldingSnapshot;
}
