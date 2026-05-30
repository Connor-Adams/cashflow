import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { NOTIFICATION_TYPE_MAX_LENGTH } from './Notification';

/**
 * Per-user, per-type notification preference (issue #266).
 *
 * At most one row per (user_id, type). A *missing* row is the default
 * `(channelInApp=true, channelEmail=false)` — the route layer returns
 * defaults for unknown types and `enqueueNotification` treats "no row"
 * as "deliver in-app".
 */
export class NotificationPreference extends Model<
  InferAttributes<NotificationPreference>,
  InferCreationAttributes<NotificationPreference>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare type: string;
  declare channelInApp: CreationOptional<boolean>;
  declare channelEmail: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export const NOTIFICATION_PREFERENCE_DEFAULTS = {
  channelInApp: true,
  channelEmail: false,
} as const;

export function initNotificationPreference(
  sequelize: Sequelize,
): typeof NotificationPreference {
  NotificationPreference.init(
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
      channelInApp: {
        type: DataTypes.BOOLEAN,
        field: 'channel_in_app',
        allowNull: false,
        defaultValue: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
      },
      channelEmail: {
        type: DataTypes.BOOLEAN,
        field: 'channel_email',
        allowNull: false,
        defaultValue: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
      },
    } as ModelAttributes<NotificationPreference>,
    {
      sequelize,
      modelName: 'NotificationPreference',
      tableName: 'notification_preferences',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'notification_preferences_user_type',
          unique: true,
          fields: ['user_id', 'type'],
        },
      ],
    },
  );
  return NotificationPreference;
}
