import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare icon: string | null;
  declare taxTreatment: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCategory(sequelize: Sequelize): typeof Category {
  Category.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(128), allowNull: false },
      icon: { type: DataTypes.STRING(64), allowNull: true },
      taxTreatment: {
        type: DataTypes.STRING(32),
        field: 'tax_treatment',
        allowNull: false,
        defaultValue: 'none',
      },
    } as ModelAttributes<Category>,
    {
      sequelize,
      modelName: 'Category',
      tableName: 'categories',
      underscored: true,
      timestamps: true,
      indexes: [{ unique: true, fields: ['household_id', 'name'] }],
    }
  );
  return Category;
}
