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
 * Severity classification for a notification row. Kept as a string union
 * rather than a DB-enum so we can introduce more levels later without
 * cross-dialect migration headaches (sqlite vs postgres handle enums
 * differently). Validated at the helper / route layer.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'warn', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Hard caps that match the migration column definitions. */
export const NOTIFICATION_TYPE_MAX_LENGTH = 64;
export const NOTIFICATION_TITLE_MAX_LENGTH = 160;

/**
 * In-app notification (issue #266). One row per delivered notification.
 *
 * The bell query reads (user_id, read_at, created_at DESC) so the
 * (user_id, read_at, created_at) composite index defined in the migration
 * covers the hot path. `data_json` is intentionally an open-shape JSON
 * column so downstream features can attach structured context (e.g. budget
 * id, transaction id, percentages) without per-feature schema changes.
 */
export class Notification extends Model<
  InferAttributes<Notification>,
  InferCreationAttributes<Notification>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare type: string;
  declare severity: CreationOptional<NotificationSeverity>;
  declare title: string;
  declare body: string;
  declare dataJson: CreationOptional<Record<string, unknown> | null>;
  declare readAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initNotification(sequelize: Sequelize): typeof Notification {
  Notification.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(NOTIFICATION_TYPE_MAX_LENGTH),
        allowNull: false,
      },
      severity: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'info',
      },
      title: {
        type: DataTypes.STRING(NOTIFICATION_TITLE_MAX_LENGTH),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      dataJson: {
        type: DataTypes.JSON,
        field: 'data_json',
        allowNull: true,
      },
      readAt: {
        type: DataTypes.DATE,
        field: 'read_at',
        allowNull: true,
      },
    } as ModelAttributes<Notification>,
    {
      sequelize,
      modelName: 'Notification',
      tableName: 'notifications',
      underscored: true,
      timestamps: true,
    },
  );
  return Notification;
}
