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
  declare ownerEntityId: number | null;
  declare associatedGroupId: string | null;
  declare currency: CreationOptional<string>;
  /**
   * Tax years (fiscal-year-end year) in which this corporation's business is a
   * personal services business (ITA s.125(7)). Per year because the status
   * turns on each year's facts. Corp entities only.
   */
  declare personalServicesBusinessYears: CreationOptional<number[]>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

/** Whether `entity` is flagged a personal services business for tax year `year`. */
export function isPersonalServicesBusinessYear(
  entity: Pick<Entity, 'personalServicesBusinessYears'>,
  year: number,
): boolean {
  return (entity.personalServicesBusinessYears ?? []).includes(year);
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
      ownerEntityId: {
        type: DataTypes.INTEGER,
        field: 'owner_entity_id',
        allowNull: true,
        defaultValue: null,
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
      personalServicesBusinessYears: {
        type: DataTypes.JSON,
        field: 'personal_services_business_years',
        allowNull: false,
        defaultValue: [],
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
