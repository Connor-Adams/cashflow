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
 * Append-only domain-event row for finance workflows (Cashflow #238).
 *
 * Distinct from AuditLog (#228):
 *   - AuditLog explains WHO changed WHAT for a human reviewer
 *     (before/after diffs + summary text).
 *   - FinanceEvent records WHAT HAPPENED as a compact, machine-oriented
 *     event suitable for replay, stream consumption, projection
 *     rebuilds, and agent context.
 *
 * Distinct from TransactionRevision (#229):
 *   - TransactionRevision is a per-row history of one entity
 *     (transactions only) keyed by field-level diff.
 *   - FinanceEvent is a cross-entity stream of canonical events.
 *
 * Distinct from ImportHistory:
 *   - ImportHistory records per-statement import outcomes
 *     (success/partial/failed counts).
 *   - FinanceEvent records the domain event `import.committed` after
 *     a statement import succeeded.
 *
 * The canonical event-type / entity-type strings live in
 * `events/financeEvents.ts` so callers pick from a known set; the
 * column is STRING for forward-compatibility (no ALTER TYPE on new
 * events).
 *
 * Payload is typed as `unknown` to force callers to narrow on read.
 */
export class FinanceEvent extends Model<
  InferAttributes<FinanceEvent>,
  InferCreationAttributes<FinanceEvent>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare actorUserId: number | null;
  declare type: string;
  declare entityType: string | null;
  declare entityId: number | null;
  declare payload: unknown;
  declare occurredAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initFinanceEvent(sequelize: Sequelize): typeof FinanceEvent {
  FinanceEvent.init(
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
      type: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      entityType: {
        type: DataTypes.STRING(64),
        field: 'entity_type',
        allowNull: true,
      },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: true,
      },
      payload: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      occurredAt: {
        type: DataTypes.DATE,
        field: 'occurred_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    } as ModelAttributes<FinanceEvent>,
    {
      sequelize,
      modelName: 'FinanceEvent',
      tableName: 'finance_events',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'finance_events_household_created_at',
          fields: ['household_id', 'created_at'],
        },
        {
          name: 'finance_events_household_entity',
          fields: ['household_id', 'entity_type', 'entity_id'],
        },
        {
          name: 'finance_events_household_type_created_at',
          fields: ['household_id', 'type', 'created_at'],
        },
      ],
    },
  );
  return FinanceEvent;
}
