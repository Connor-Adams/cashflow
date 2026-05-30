import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class HouseholdInvite extends Model<
  InferAttributes<HouseholdInvite>,
  InferCreationAttributes<HouseholdInvite>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare createdByUserId: number;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare acceptedAt: Date | null;
  declare acceptedByUserId: number | null;
  // #281 — optional email captured at invite creation for the inviter's own
  // record-keeping. Not used to send mail in v1; nullable for legacy invites.
  declare optionalEmail: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initHouseholdInvite(sequelize: Sequelize): typeof HouseholdInvite {
  HouseholdInvite.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      createdByUserId: {
        type: DataTypes.INTEGER,
        field: 'created_by_user_id',
        allowNull: false,
      },
      tokenHash: {
        type: DataTypes.STRING(128),
        field: 'token_hash',
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        field: 'expires_at',
        allowNull: false,
      },
      acceptedAt: {
        type: DataTypes.DATE,
        field: 'accepted_at',
        allowNull: true,
      },
      acceptedByUserId: {
        type: DataTypes.INTEGER,
        field: 'accepted_by_user_id',
        allowNull: true,
      },
      optionalEmail: {
        type: DataTypes.STRING(255),
        field: 'optional_email',
        allowNull: true,
      },
    } as ModelAttributes<HouseholdInvite>,
    {
      sequelize,
      modelName: 'HouseholdInvite',
      tableName: 'household_invites',
      underscored: true,
      timestamps: true,
    }
  );
  return HouseholdInvite;
}
