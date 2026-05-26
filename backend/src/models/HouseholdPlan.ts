import {
  Model, DataTypes, type Sequelize, type ModelAttributes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';

export class HouseholdPlan extends Model<
  InferAttributes<HouseholdPlan>, InferCreationAttributes<HouseholdPlan>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHouseholdPlan(sequelize: Sequelize): typeof HouseholdPlan {
  HouseholdPlan.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(120), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<HouseholdPlan>,
    {
      sequelize,
      modelName: 'HouseholdPlan',
      tableName: 'household_plans',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'household_plans_household_id', fields: ['household_id'] },
      ],
    }
  );
  return HouseholdPlan;
}
