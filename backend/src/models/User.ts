import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare displayName: string;
  declare globalRole: CreationOptional<string>;
  declare passwordHash: string;
  declare passwordSalt: string;
  declare passwordParams: string;
  declare dob: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initUser(sequelize: Sequelize): typeof User {
  User.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      email: { type: DataTypes.STRING(320), allowNull: false },
      displayName: {
        type: DataTypes.STRING(160),
        field: 'display_name',
        allowNull: false,
      },
      globalRole: {
        type: DataTypes.STRING(32),
        field: 'global_role',
        allowNull: false,
        defaultValue: 'user',
      },
      passwordHash: {
        type: DataTypes.STRING(256),
        field: 'password_hash',
        allowNull: false,
      },
      passwordSalt: {
        type: DataTypes.STRING(128),
        field: 'password_salt',
        allowNull: false,
      },
      passwordParams: {
        type: DataTypes.STRING(128),
        field: 'password_params',
        allowNull: false,
      },
      dob: { type: DataTypes.STRING(10), allowNull: true },
    } as ModelAttributes<User>,
    {
      sequelize,
      modelName: 'User',
      tableName: 'users',
      underscored: true,
      timestamps: true,
    }
  );
  return User;
}
