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
 * `(channelInApp=true, channelEmail=false, channelPush=false)` — the route
 * layer returns defaults for unknown types and `enqueueNotification` treats
 * "no row" as "deliver in-app, no push".
 *
 * `channelPush` (issue #651) is opt-in (default false): a user only receives
 * web-push when they have explicitly enabled it AND have ≥1 active push
 * subscription.
 *
 * `digestDayOfWeek` (issue #796) only applies to `type='digest.weekly'`: the
 * weekday (0=Sun … 6=Sat) the user wants their digest to land. Default 1
 * (Monday), matching the historical cron anchor. Ignored for other types.
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
  declare channelPush: CreationOptional<boolean>;
  declare digestDayOfWeek: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export const NOTIFICATION_PREFERENCE_DEFAULTS = {
  channelInApp: true,
  channelEmail: false,
  channelPush: false,
  digestDayOfWeek: 1,
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
      channelPush: {
        type: DataTypes.BOOLEAN,
        field: 'channel_push',
        allowNull: false,
        defaultValue: NOTIFICATION_PREFERENCE_DEFAULTS.channelPush,
      },
      digestDayOfWeek: {
        type: DataTypes.SMALLINT,
        field: 'digest_day_of_week',
        allowNull: false,
        defaultValue: NOTIFICATION_PREFERENCE_DEFAULTS.digestDayOfWeek,
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
