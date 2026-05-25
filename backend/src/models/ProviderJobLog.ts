import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ProviderJobStatus =
  | 'ok'
  | 'not_found'
  | 'error'
  | 'budget_exceeded'
  | 'rate_limited';

export class ProviderJobLog extends Model<
  InferAttributes<ProviderJobLog>,
  InferCreationAttributes<ProviderJobLog>
> {
  declare id: CreationOptional<number>;
  declare provider: string;
  declare function: string;
  declare symbol: string | null;
  declare status: ProviderJobStatus;
  declare httpStatus: number | null;
  declare errorMessage: string | null;
  declare fetchedAt: Date;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initProviderJobLog(sequelize: Sequelize): typeof ProviderJobLog {
  ProviderJobLog.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      provider: { type: DataTypes.STRING(64), allowNull: false },
      function: { type: DataTypes.STRING(64), allowNull: false },
      symbol: { type: DataTypes.STRING(64), allowNull: true },
      status: { type: DataTypes.STRING(32), allowNull: false },
      httpStatus: {
        type: DataTypes.INTEGER,
        field: 'http_status',
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.STRING(1024),
        field: 'error_message',
        allowNull: true,
      },
      fetchedAt: {
        type: DataTypes.DATE,
        field: 'fetched_at',
        allowNull: false,
      },
    } as ModelAttributes<ProviderJobLog>,
    {
      sequelize,
      modelName: 'ProviderJobLog',
      tableName: 'provider_job_log',
      underscored: true,
      timestamps: true,
    },
  );
  return ProviderJobLog;
}
