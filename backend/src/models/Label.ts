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
 * A free-text label (issue #270). Household-scoped, max 32 chars, case-
 * insensitively unique within a household (enforced by a functional unique
 * index on (household_id, LOWER(name)) — see migration
 * 20260609000001-create-labels). Labels are cross-cutting: a transaction can
 * carry many, independent of its single mutually-exclusive category.
 */
export class Label extends Model<
  InferAttributes<Label>,
  InferCreationAttributes<Label>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initLabel(sequelize: Sequelize): typeof Label {
  Label.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(32), allowNull: false },
    } as ModelAttributes<Label>,
    {
      sequelize,
      modelName: 'Label',
      tableName: 'labels',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['household_id'] }],
    }
  );
  return Label;
}
