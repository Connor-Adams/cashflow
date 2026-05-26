import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type JobRunStatus = 'running' | 'success' | 'failed' | 'skipped';

export class JobRun extends Model<
  InferAttributes<JobRun>,
  InferCreationAttributes<JobRun>
> {
  declare id: CreationOptional<number>;
  declare jobName: string;
  declare startedAt: Date;
  declare finishedAt: Date | null;
  declare status: JobRunStatus;
  declare durationMs: number | null;
  declare errorMessage: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initJobRun(sequelize: Sequelize): typeof JobRun {
  JobRun.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      jobName: { type: DataTypes.STRING(64), field: 'job_name', allowNull: false },
      startedAt: { type: DataTypes.DATE, field: 'started_at', allowNull: false },
      finishedAt: { type: DataTypes.DATE, field: 'finished_at', allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false },
      durationMs: { type: DataTypes.INTEGER, field: 'duration_ms', allowNull: true },
      errorMessage: { type: DataTypes.TEXT, field: 'error_message', allowNull: true },
    } as ModelAttributes<JobRun>,
    {
      sequelize,
      modelName: 'JobRun',
      tableName: 'job_runs',
      underscored: true,
      timestamps: true,
    },
  );
  return JobRun;
}
