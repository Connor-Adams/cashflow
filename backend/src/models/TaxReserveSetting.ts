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
 * Per-household, per-currency tax reserve setting (issue #223).
 *
 * One row per (household_id, currency). A household running both a CAD
 * sole-prop and a USD subcontract can set distinct reserve percentages
 * for each.
 *
 * Money/percent columns are DECIMAL(7,4) → typed as string for lossless
 * transport, matching the rest of the codebase. reservePercent is a
 * fraction in [0, 1].
 */
export class TaxReserveSetting extends Model<
  InferAttributes<TaxReserveSetting>,
  InferCreationAttributes<TaxReserveSetting>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare currency: string;
  /** DECIMAL(7,4) — fraction in [0, 1]. Default '0.2500' (25%). */
  declare reservePercent: CreationOptional<string>;
  /** Free-text rationale surfaced in the UI. */
  declare note: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

/** Default reserve percent applied when a household has no row for a currency. */
export const DEFAULT_TAX_RESERVE_PERCENT = '0.2500';

export function initTaxReserveSetting(
  sequelize: Sequelize,
): typeof TaxReserveSetting {
  TaxReserveSetting.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      reservePercent: {
        type: DataTypes.DECIMAL(7, 4),
        field: 'reserve_percent',
        allowNull: false,
        defaultValue: DEFAULT_TAX_RESERVE_PERCENT,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    } as ModelAttributes<TaxReserveSetting>,
    {
      sequelize,
      modelName: 'TaxReserveSetting',
      tableName: 'tax_reserve_settings',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'tax_reserve_settings_household_id_currency',
          unique: true,
          fields: ['household_id', 'currency'],
        },
      ],
    },
  );
  return TaxReserveSetting;
}
