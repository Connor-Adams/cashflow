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
 * UserSimplefinIntegration (issue #790) — per-user SimpleFIN Bridge credential
 * store. Mirrors UserEmailIntegration: an external integration-credential table
 * that feeds an import SOURCE into the existing Account/Transaction primitives.
 * It is NOT a 14th primitive — it carries only a simple connection lifecycle, so
 * per the spine rules it folds as a credential-store model.
 *
 * The SimpleFIN access URL (an https URL with embedded HTTP basic-auth creds) is
 * stored encrypted at rest via symmetricEncryption.encryptSecret(); the column
 * never holds plaintext credentials.
 */
export class UserSimplefinIntegration extends Model<
  InferAttributes<UserSimplefinIntegration>,
  InferCreationAttributes<UserSimplefinIntegration>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare accessUrlEncrypted: string;
  declare status: CreationOptional<string>;
  declare statusReason: string | null;
  declare lastSyncedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserSimplefinIntegration(
  sequelize: Sequelize,
): typeof UserSimplefinIntegration {
  UserSimplefinIntegration.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      accessUrlEncrypted: {
        type: DataTypes.TEXT,
        field: 'access_url_encrypted',
        allowNull: false,
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
      lastSyncedAt: {
        type: DataTypes.DATE,
        field: 'last_synced_at',
        allowNull: true,
      },
    } as ModelAttributes<UserSimplefinIntegration>,
    {
      sequelize,
      modelName: 'UserSimplefinIntegration',
      tableName: 'user_simplefin_integrations',
      underscored: true,
      timestamps: true,
    },
  );
  return UserSimplefinIntegration;
}
