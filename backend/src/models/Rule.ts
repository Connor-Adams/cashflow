import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
export class Rule extends Model<
  InferAttributes<Rule>,
  InferCreationAttributes<Rule>
> {
  declare id: CreationOptional<number>;
  declare merchantPattern: string;
  declare householdId: number | null;
  declare createdByUserId: number | null;
  declare matchKind: string;
  declare priority: number;
  declare category: string | null;
  declare categoryId: number | null;
  declare isBusiness: boolean;
  declare splitType: string;
  /** Stored as DECIMAL; may be string when read from SQLite */
  declare pctMe: string | null;
  declare pctPartner: string | null;
  /** Inclusive lower bound on Transaction.date; null = "always". */
  declare effectiveFrom: string | null;
  /** Exclusive upper bound on Transaction.date; null = "forever". */
  declare effectiveTo: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initRule(sequelize: Sequelize): typeof Rule {
  Rule.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      merchantPattern: {
        type: DataTypes.STRING(512),
        field: 'merchant_pattern',
        allowNull: false,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      createdByUserId: {
        type: DataTypes.INTEGER,
        field: 'created_by_user_id',
        allowNull: true,
      },
      matchKind: {
        type: DataTypes.STRING(16),
        field: 'match_kind',
        allowNull: false,
        defaultValue: 'substring',
      },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      category: { type: DataTypes.STRING(128), allowNull: true },
      categoryId: { type: DataTypes.INTEGER, field: 'category_id', allowNull: true },
      isBusiness: {
        type: DataTypes.BOOLEAN,
        field: 'is_business',
        allowNull: false,
        defaultValue: false,
      },
      splitType: {
        type: DataTypes.STRING(16),
        field: 'split_type',
        allowNull: false,
        defaultValue: 'me',
      },
      pctMe: { type: DataTypes.DECIMAL(5, 4), field: 'pct_me', allowNull: true },
      pctPartner: {
        type: DataTypes.DECIMAL(5, 4),
        field: 'pct_partner',
        allowNull: true,
      },
      effectiveFrom: {
        type: DataTypes.DATEONLY,
        field: 'effective_from',
        allowNull: true,
      },
      effectiveTo: {
        type: DataTypes.DATEONLY,
        field: 'effective_to',
        allowNull: true,
      },
    } as ModelAttributes<Rule>,
    {
      sequelize,
      modelName: 'Rule',
      tableName: 'rules',
      underscored: true,
      timestamps: true,
    }
  );
  Rule.addHook('beforeSave', async (instance: Rule, options) => {
    if (instance.householdId == null) return;
    const { reconcileCategoryField } = await import('../categories/reconcileCategoryField');
    await reconcileCategoryField({
      instance, householdId: instance.householdId,
      strField: 'category', idField: 'categoryId',
      transaction: options.transaction ?? undefined,
    });
  });
  return Rule;
}
