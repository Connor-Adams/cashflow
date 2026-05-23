import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserCaptureToken extends Model<
  InferAttributes<UserCaptureToken>,
  InferCreationAttributes<UserCaptureToken>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare tokenHash: string;
  declare label: string;
  declare lastUsedAt: Date | null;
  declare revokedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserCaptureToken(sequelize: Sequelize): typeof UserCaptureToken {
  UserCaptureToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      tokenHash: {
        type: DataTypes.STRING(64),
        field: 'token_hash',
        allowNull: false,
      },
      label: { type: DataTypes.STRING(64), allowNull: false },
      lastUsedAt: { type: DataTypes.DATE, field: 'last_used_at', allowNull: true },
      revokedAt: { type: DataTypes.DATE, field: 'revoked_at', allowNull: true },
    } as ModelAttributes<UserCaptureToken>,
    {
      sequelize,
      modelName: 'UserCaptureToken',
      tableName: 'user_capture_tokens',
      underscored: true,
      timestamps: true,
    }
  );
  return UserCaptureToken;
}
