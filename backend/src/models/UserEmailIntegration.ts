import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserEmailIntegration extends Model<
  InferAttributes<UserEmailIntegration>,
  InferCreationAttributes<UserEmailIntegration>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare provider: string;
  declare accountEmail: string | null;
  declare accessTokenEncrypted: string;
  declare refreshTokenEncrypted: string | null;
  declare expiresAt: Date | null;
  declare scopes: string | null;
  declare lastScanAt: Date | null;
  declare lastHistoryId: string | null;
  declare status: CreationOptional<string>;
  declare statusReason: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserEmailIntegration(
  sequelize: Sequelize,
): typeof UserEmailIntegration {
  UserEmailIntegration.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      provider: { type: DataTypes.STRING(32), allowNull: false },
      accountEmail: {
        type: DataTypes.STRING(256),
        field: 'account_email',
        allowNull: true,
      },
      accessTokenEncrypted: {
        type: DataTypes.TEXT,
        field: 'access_token_encrypted',
        allowNull: false,
      },
      refreshTokenEncrypted: {
        type: DataTypes.TEXT,
        field: 'refresh_token_encrypted',
        allowNull: true,
      },
      expiresAt: { type: DataTypes.DATE, field: 'expires_at', allowNull: true },
      scopes: { type: DataTypes.TEXT, allowNull: true },
      lastScanAt: { type: DataTypes.DATE, field: 'last_scan_at', allowNull: true },
      lastHistoryId: {
        type: DataTypes.STRING(128),
        field: 'last_history_id',
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'connected',
      },
      statusReason: {
        type: DataTypes.TEXT,
        field: 'status_reason',
        allowNull: true,
      },
    } as ModelAttributes<UserEmailIntegration>,
    {
      sequelize,
      modelName: 'UserEmailIntegration',
      tableName: 'user_email_integrations',
      underscored: true,
      timestamps: true,
    },
  );
  return UserEmailIntegration;
}
