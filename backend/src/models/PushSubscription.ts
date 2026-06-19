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
 * Web-push subscription (issue #651). One row per browser push endpoint a
 * user has granted. The `enqueueNotification` dispatch path fans a web-push
 * out to every active subscription a user owns when their `channel_push`
 * preference is enabled.
 *
 * `endpoint` is globally unique (the push service's per-browser URL): a
 * re-subscribe from the same browser upserts on `endpoint` rather than
 * duplicating. `(p256dh, auth)` are the ECDH/auth secrets from the browser's
 * `PushSubscription.toJSON().keys`, required by the web-push encryption.
 *
 * Rows cascade on user deletion — we never want orphaned endpoints around.
 * A dead endpoint (push service returns 404/410) is pruned by the send path.
 */
export class PushSubscription extends Model<
  InferAttributes<PushSubscription>,
  InferCreationAttributes<PushSubscription>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare endpoint: string;
  declare p256dh: string;
  declare auth: string;
  declare userAgent: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initPushSubscription(
  sequelize: Sequelize,
): typeof PushSubscription {
  PushSubscription.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      endpoint: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      p256dh: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      auth: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      userAgent: {
        type: DataTypes.TEXT,
        field: 'user_agent',
        allowNull: true,
      },
    } as ModelAttributes<PushSubscription>,
    {
      sequelize,
      modelName: 'PushSubscription',
      tableName: 'push_subscriptions',
      underscored: true,
      timestamps: true,
      indexes: [
        {
          name: 'push_subscriptions_endpoint_unique',
          unique: true,
          fields: ['endpoint'],
        },
        {
          name: 'push_subscriptions_user',
          fields: ['user_id'],
        },
      ],
    },
  );
  return PushSubscription;
}
