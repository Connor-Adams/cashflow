import {
  Model,
  DataTypes,
  Op,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { normalizeCategoryName } from '../categories/normalizeName';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare parentId: number | null;
  declare name: string;
  declare nameKey: CreationOptional<string>;
  declare icon: string | null;
  declare taxTreatment: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCategory(sequelize: Sequelize): typeof Category {
  Category.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      parentId: { type: DataTypes.INTEGER, field: 'parent_id', allowNull: true },
      name: { type: DataTypes.STRING(128), allowNull: false },
      nameKey: { type: DataTypes.STRING(128), field: 'name_key', allowNull: false },
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
      hooks: {
        beforeValidate(instance: Category) {
          if (instance.name != null) {
            instance.nameKey = normalizeCategoryName(instance.name);
          }
        },
      },
      indexes: [
        {
          name: 'categories_household_parent_name_key_unique',
          unique: true,
          fields: ['household_id', 'parent_id', 'name_key'],
          where: { parent_id: { [Op.ne]: null } },
        },
        {
          name: 'categories_household_root_name_key_unique',
          unique: true,
          fields: ['household_id', 'name_key'],
          where: { parent_id: null },
        },
      ],
    }
  );
  return Category;
}
