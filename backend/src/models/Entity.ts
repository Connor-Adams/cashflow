import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type EntityKind = 'personal' | 'corp';

export class Entity extends Model<
  InferAttributes<Entity>,
  InferCreationAttributes<Entity>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare kind: EntityKind;
  declare legalName: string;
  declare jurisdiction: CreationOptional<string>;
  declare fiscalYearEnd: string | null;
  declare spouseEntityId: number | null;
  declare associatedGroupId: string | null;
  declare currency: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initEntity(sequelize: Sequelize): typeof Entity {
  Entity.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      legalName: { type: DataTypes.STRING(160), field: 'legal_name', allowNull: false },
      jurisdiction: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'CA-ON',
      },
      fiscalYearEnd: {
        type: DataTypes.STRING(10),
        field: 'fiscal_year_end',
        allowNull: true,
      },
      spouseEntityId: {
        type: DataTypes.INTEGER,
        field: 'spouse_entity_id',
        allowNull: true,
      },
      associatedGroupId: {
        type: DataTypes.STRING(64),
        field: 'associated_group_id',
        allowNull: true,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'CAD',
      },
    } as ModelAttributes<Entity>,
    {
      sequelize,
      modelName: 'Entity',
      tableName: 'tax_entities',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['spouse_entity_id'] },
        { fields: ['associated_group_id'] },
      ],
    }
  );
  return Entity;
}
