import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Contact extends Model<
  InferAttributes<Contact>,
  InferCreationAttributes<Contact>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initContact(sequelize: Sequelize): typeof Contact {
  Contact.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(160), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
    } as ModelAttributes<Contact>,
    {
      sequelize,
      modelName: 'Contact',
      tableName: 'contacts',
      underscored: true,
      timestamps: true,
    }
  );
  return Contact;
}
