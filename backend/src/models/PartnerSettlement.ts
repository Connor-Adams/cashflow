import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type PartnerSettlementDirection = 'i_paid_partner' | 'partner_paid_me';

export const PARTNER_SETTLEMENT_DIRECTIONS: readonly PartnerSettlementDirection[] = [
  'i_paid_partner',
  'partner_paid_me',
] as const;

export class PartnerSettlement extends Model<
  InferAttributes<PartnerSettlement>,
  InferCreationAttributes<PartnerSettlement>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare contactId: number;
  declare direction: PartnerSettlementDirection;
  declare currency: string;
  declare amount: string;
  declare settledDate: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPartnerSettlement(sequelize: Sequelize): typeof PartnerSettlement {
  PartnerSettlement.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      contactId: {
        type: DataTypes.INTEGER,
        field: 'contact_id',
        allowNull: false,
      },
      direction: { type: DataTypes.STRING(32), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      settledDate: {
        type: DataTypes.DATEONLY,
        field: 'settled_date',
        allowNull: false,
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<PartnerSettlement>,
    {
      sequelize,
      modelName: 'PartnerSettlement',
      tableName: 'partner_settlements',
      underscored: true,
      timestamps: true,
    }
  );
  return PartnerSettlement;
}
