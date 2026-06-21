import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserAuditToken extends Model<
  InferAttributes<UserAuditToken>,
  InferCreationAttributes<UserAuditToken>
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

export function initUserAuditToken(sequelize: Sequelize): typeof UserAuditToken {
  UserAuditToken.init(
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
    } as ModelAttributes<UserAuditToken>,
    {
      sequelize,
      modelName: 'UserAuditToken',
      tableName: 'user_audit_tokens',
      underscored: true,
      timestamps: true,
    }
  );
  return UserAuditToken;
}
