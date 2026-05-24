import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type CarryforwardKind =
  | 'cap_loss'
  | 'rrsp_room'
  | 'grip'
  | 'cda'
  | 'erdtoh'
  | 'nerdtoh'
  | 'non_cap_loss'
  | 'aaii'
  | 'instalments_paid';

export class Carryforward extends Model<
  InferAttributes<Carryforward>,
  InferCreationAttributes<Carryforward>
> {
  declare id: CreationOptional<number>;
  declare entityId: number;
  declare kind: CarryforwardKind;
  declare asOfYear: number;
  declare amount: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCarryforward(sequelize: Sequelize): typeof Carryforward {
  Carryforward.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      entityId: {
        type: DataTypes.INTEGER,
        field: 'entity_id',
        allowNull: false,
      },
      kind: { type: DataTypes.STRING(24), allowNull: false },
      asOfYear: {
        type: DataTypes.INTEGER,
        field: 'as_of_year',
        allowNull: false,
      },
      amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<Carryforward>,
    {
      sequelize,
      modelName: 'Carryforward',
      tableName: 'carryforwards',
      underscored: true,
      timestamps: true,
    }
  );
  return Carryforward;
}
