import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class HouseholdMember extends Model<
  InferAttributes<HouseholdMember>,
  InferCreationAttributes<HouseholdMember>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  declare role: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHouseholdMember(sequelize: Sequelize): typeof HouseholdMember {
  HouseholdMember.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      role: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'member' },
    } as ModelAttributes<HouseholdMember>,
    {
      sequelize,
      modelName: 'HouseholdMember',
      tableName: 'household_members',
      underscored: true,
      timestamps: true,
    }
  );
  return HouseholdMember;
}
