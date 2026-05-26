import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type JobLastStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant';

export class Job extends Model<
  InferAttributes<Job>,
  InferCreationAttributes<Job>
> {
  declare name: string;
  declare enabledOverride: boolean | null;
  declare cronOverride: string | null;
  declare lastRunAt: Date | null;
  declare lastFinishedAt: Date | null;
  declare lastStatus: JobLastStatus | null;
  declare lastDurationMs: number | null;
  declare lastError: string | null;
  declare lastResultJson: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initJob(sequelize: Sequelize): typeof Job {
  Job.init(
    {
      name: { type: DataTypes.STRING(128), primaryKey: true, allowNull: false },
      enabledOverride: { type: DataTypes.BOOLEAN, field: 'enabled_override', allowNull: true },
      cronOverride: { type: DataTypes.STRING(128), field: 'cron_override', allowNull: true },
      lastRunAt: { type: DataTypes.DATE, field: 'last_run_at', allowNull: true },
      lastFinishedAt: { type: DataTypes.DATE, field: 'last_finished_at', allowNull: true },
      lastStatus: { type: DataTypes.STRING(32), field: 'last_status', allowNull: true },
      lastDurationMs: { type: DataTypes.INTEGER, field: 'last_duration_ms', allowNull: true },
      lastError: { type: DataTypes.STRING(1024), field: 'last_error', allowNull: true },
      lastResultJson: { type: DataTypes.STRING(2048), field: 'last_result_json', allowNull: true },
    } as ModelAttributes<Job>,
    {
      sequelize,
      modelName: 'Job',
      tableName: 'jobs',
      underscored: true,
      timestamps: true,
    },
  );
  return Job;
}
