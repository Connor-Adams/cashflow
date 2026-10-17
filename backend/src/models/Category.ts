import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { normalizeCategoryName } from '../categories/normalizeName';
import { CategoryError } from '../categories/errors';

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
            // "/" is reserved as the category path separator (see categories/path.ts);
            // a name carrying it would otherwise persist as a flat row that shadows a
            // nested category. Enforce the invariant for every writer, last resort.
            if (instance.name.includes('/')) {
              throw new CategoryError(
                'invalid_name',
                `category name may not contain "/": ${instance.name}`,
              );
            }
            instance.nameKey = normalizeCategoryName(instance.name);
          }
        },
      },
      indexes: [
        // One name per household, wherever it sits in the tree. Replaced the two
        // partial (root / nested) uniques in migration
        // 20260930000001-merge-duplicate-category-names.js: parent-scoped
        // uniqueness let the nightly enrichment job fork 15 categories in
        // household 1 into a root/child pair sharing one name, and every
        // name-keyed consumer (budget spend buckets, the `final_category` string
        // mirror) then double-counted or lost spend.
        {
          name: 'categories_household_name_key_unique',
          unique: true,
          fields: ['household_id', 'name_key'],
        },
      ],
    }
  );
  return Category;
}
