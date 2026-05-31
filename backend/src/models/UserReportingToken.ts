import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class UserReportingToken extends Model<
  InferAttributes<UserReportingToken>,
  InferCreationAttributes<UserReportingToken>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare tokenHash: string;
  declare label: CreationOptional<string>;
  declare lastUsedAt: CreationOptional<Date | null>;
  declare revokedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUserReportingToken(sequelize: Sequelize): typeof UserReportingToken {
  UserReportingToken.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, field: 'user_id', allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), field: 'token_hash', allowNull: false },
      label: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'Reporting',
      },
      lastUsedAt: { type: DataTypes.DATE, field: 'last_used_at', allowNull: true, defaultValue: null },
      revokedAt: { type: DataTypes.DATE, field: 'revoked_at', allowNull: true, defaultValue: null },
    } as ModelAttributes<UserReportingToken>,
    {
      sequelize,
      modelName: 'UserReportingToken',
      tableName: 'user_reporting_tokens',
      underscored: true,
      timestamps: true,
    },
  );
  return UserReportingToken;
}
