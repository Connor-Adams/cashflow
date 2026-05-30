import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ServerErrorEvent extends Model<
  InferAttributes<ServerErrorEvent>,
  InferCreationAttributes<ServerErrorEvent>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare userId: number | null;
  declare method: string;
  declare path: string;
  declare status: number;
  declare message: string;
  declare stack: string | null;
  declare requestId: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initServerErrorEvent(sequelize: Sequelize): typeof ServerErrorEvent {
  ServerErrorEvent.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
      method: { type: DataTypes.STRING(16), allowNull: false },
      path: { type: DataTypes.STRING(512), allowNull: false },
      status: { type: DataTypes.INTEGER, allowNull: false },
      message: { type: DataTypes.TEXT, allowNull: false },
      stack: { type: DataTypes.TEXT, allowNull: true },
      requestId: { type: DataTypes.STRING(64), field: 'request_id', allowNull: true },
    } as ModelAttributes<ServerErrorEvent>,
    {
      sequelize,
      modelName: 'ServerErrorEvent',
      tableName: 'server_error_events',
      underscored: true,
      timestamps: true,
    }
  );
  return ServerErrorEvent;
}
