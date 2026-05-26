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
 * Join row marking a single (budget, transaction) pair as excluded from
 * spend aggregation. See migration 20260531000002-budget-exclusions for the
 * full rationale.
 *
 * Uniqueness on (budget_id, transaction_id) is enforced at the DB level,
 * so POSTing the same exclusion twice is idempotent at the route layer.
 */
export class BudgetExclusion extends Model<
  InferAttributes<BudgetExclusion>,
  InferCreationAttributes<BudgetExclusion>
> {
  declare id: CreationOptional<number>;
  declare budgetId: number;
  declare transactionId: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initBudgetExclusion(sequelize: Sequelize): typeof BudgetExclusion {
  BudgetExclusion.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      budgetId: {
        type: DataTypes.INTEGER,
        field: 'budget_id',
        allowNull: false,
      },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
    } as ModelAttributes<BudgetExclusion>,
    {
      sequelize,
      modelName: 'BudgetExclusion',
      tableName: 'budget_exclusions',
      underscored: true,
      timestamps: true,
    }
  );
  return BudgetExclusion;
}
