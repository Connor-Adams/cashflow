import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { normalizeContactName } from '../contacts/normalizeContactName';

export class Contact extends Model<
  InferAttributes<Contact>,
  InferCreationAttributes<Contact>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: CreationOptional<number | null>;
  declare name: string;
  declare notes: string | null;
  /** Comma-separated extra match terms for the transfer link pass (per-person
   *  loan ledger). Null means match on name only. */
  declare aliases: CreationOptional<string | null>;
  /**
   * #375 — marks this Contact as the household's partner. Drives the Partner
   * Fairness dashboard's partner_inflows / non_partner_inflows split: inflows
   * whose counterparty_contact_id points at a partner Contact count as partner
   * inflows; all other positive-amount shared rows count as non-partner.
   * Default false so legacy rows behave as before.
   */
  declare isPartner: CreationOptional<boolean>;
  /**
   * Self-account flag: true when the user has confirmed this Contact is their
   * own identity (e.g. "Connor Adams RBC" — a transfer to their own account).
   * Confirmed self-accounts are excluded from the transfer-link pass because
   * you cannot owe yourself. Suggested automatically via name-token overlap;
   * the user must confirm via PATCH /api/contacts/:id { isSelf: true }.
   * Default false so legacy rows behave as before.
   *
   * Spine note: a discriminator field on the Contact primitive, NOT a new primitive.
   */
  declare isSelf: CreationOptional<boolean>;
  /** Lowercase + whitespace-collapsed key for dedup; auto-set by a hook. */
  declare normalizedName: CreationOptional<string | null>;
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
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: true,
      },
      name: { type: DataTypes.STRING(160), allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
      aliases: { type: DataTypes.STRING(500), allowNull: true },
      isPartner: {
        type: DataTypes.BOOLEAN,
        field: 'is_partner',
        allowNull: false,
        defaultValue: false,
      },
      isSelf: {
        type: DataTypes.BOOLEAN,
        field: 'is_self',
        allowNull: false,
        defaultValue: false,
      },
      normalizedName: {
        type: DataTypes.STRING(160),
        field: 'normalized_name',
        allowNull: true,
      },
    } as ModelAttributes<Contact>,
    {
      sequelize,
      modelName: 'Contact',
      tableName: 'contacts',
      underscored: true,
      timestamps: true,
    }
  );
  Contact.beforeValidate((contact) => {
    contact.set('normalizedName', normalizeContactName(contact.get('name')));
  });
  return Contact;
}
