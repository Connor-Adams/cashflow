import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ClientErrorEvent extends Model<
  InferAttributes<ClientErrorEvent>,
  InferCreationAttributes<ClientErrorEvent>
> {
  declare id: CreationOptional<number>;
  declare householdId: number | null;
  declare userId: number | null;
  declare level: string;
  declare event: string | null;
  declare message: string;
  declare path: string | null;
  declare requestId: string | null;
  declare fieldsJson: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initClientErrorEvent(sequelize: Sequelize): typeof ClientErrorEvent {
  ClientErrorEvent.init(
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
      level: { type: DataTypes.STRING(16), allowNull: false },
      event: { type: DataTypes.STRING(128), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: false },
      path: { type: DataTypes.STRING(512), allowNull: true },
      requestId: { type: DataTypes.STRING(64), field: 'request_id', allowNull: true },
      fieldsJson: { type: DataTypes.TEXT, field: 'fields_json', allowNull: true },
    } as ModelAttributes<ClientErrorEvent>,
    {
      sequelize,
      modelName: 'ClientErrorEvent',
      tableName: 'client_error_events',
      underscored: true,
      timestamps: true,
    }
  );
  return ClientErrorEvent;
}
