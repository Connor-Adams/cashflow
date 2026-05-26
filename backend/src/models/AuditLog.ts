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
 * Append-only audit-log entry for finance-data mutations (Cashflow #228).
 *
 * Stored as a plain STRING for both `action` and `entityType` so adding
 * new sources later does not require an ALTER TYPE migration. The
 * `audit/log.ts` helper module owns the canonical action/entityType
 * constants and validates input at the call sites.
 *
 * before/after/metadata are typed as `unknown` rather than a wider
 * JSON-value alias so callers must explicitly narrow before reading —
 * the column is free-form and we do not want consumers to assume a
 * fixed shape.
 */
export class AuditLog extends Model<
  InferAttributes<AuditLog>,
  InferCreationAttributes<AuditLog>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare actorUserId: number | null;
  declare action: string;
  declare entityType: string;
  declare entityId: number | null;
  declare summary: string | null;
  declare before: unknown;
  declare after: unknown;
  declare metadata: unknown;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initAuditLog(sequelize: Sequelize): typeof AuditLog {
  AuditLog.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      actorUserId: {
        type: DataTypes.INTEGER,
        field: 'actor_user_id',
        allowNull: true,
      },
      action: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      entityType: {
        type: DataTypes.STRING(64),
        field: 'entity_type',
        allowNull: false,
      },
      entityId: {
        // INTEGER, not BIGINT — see migration comment for rationale.
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      summary: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      before: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      after: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
    } as ModelAttributes<AuditLog>,
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_log',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'audit_log_household_created_at',
          fields: ['household_id', 'created_at'],
        },
        {
          name: 'audit_log_household_entity',
          fields: ['household_id', 'entity_type', 'entity_id'],
        },
        {
          name: 'audit_log_household_action',
          fields: ['household_id', 'action'],
        },
      ],
    },
  );
  return AuditLog;
}
