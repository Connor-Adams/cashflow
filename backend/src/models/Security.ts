import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Security extends Model<
  InferAttributes<Security>,
  InferCreationAttributes<Security>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare symbol: string;
  declare name: string | null;
  declare assetType: string | null;
  declare currency: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initSecurity(sequelize: Sequelize): typeof Security {
  Security.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      symbol: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(256), allowNull: true },
      assetType: {
        type: DataTypes.STRING(64),
        field: 'asset_type',
        allowNull: true,
      },
      currency: { type: DataTypes.STRING(3), allowNull: false },
    } as ModelAttributes<Security>,
    {
      sequelize,
      modelName: 'Security',
      tableName: 'securities',
      underscored: true,
      timestamps: true,
    }
  );
  return Security;
}
