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
 * Bearer-token scopes. One status machine (minted → used → revoked, with an
 * optional expiry) folded from three former tables (user_audit_tokens,
 * user_reporting_tokens, user_capture_tokens) — see migration
 * 20261019000001-fold-user-token-tables. Per-scope behaviour (plaintext
 * prefix, TTL, read-only) lives in `auth/scopedToken.ts`.
 */
export const TOKEN_SCOPES = ['audit', 'reporting', 'capture'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export class UserToken extends Model<InferAttributes<UserToken>, InferCreationAttributes<UserToken>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare scope: TokenScope;
  declare tokenHash: string;
  declare label: string;
  declare lastUsedAt: Date | null;
  declare revokedAt: Date | null;
  declare expiresAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserToken(sequelize: Sequelize): typeof UserToken {
  UserToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      scope: {
        type: DataTypes.STRING(16),
        allowNull: false,
        validate: { isIn: [TOKEN_SCOPES as unknown as string[]] },
      },
      tokenHash: { type: DataTypes.STRING(64), field: 'token_hash', allowNull: false, unique: true },
      label: { type: DataTypes.STRING(64), allowNull: false },
      lastUsedAt: { type: DataTypes.DATE, field: 'last_used_at', allowNull: true },
      revokedAt: { type: DataTypes.DATE, field: 'revoked_at', allowNull: true },
      expiresAt: { type: DataTypes.DATE, field: 'expires_at', allowNull: true },
    } as ModelAttributes<UserToken>,
    {
      sequelize,
      modelName: 'UserToken',
      tableName: 'user_tokens',
      underscored: true,
      timestamps: true,
    },
  );
  return UserToken;
}
