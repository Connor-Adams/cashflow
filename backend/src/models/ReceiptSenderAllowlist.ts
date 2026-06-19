import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ReceiptSenderAllowlist extends Model<
  InferAttributes<ReceiptSenderAllowlist>,
  InferCreationAttributes<ReceiptSenderAllowlist>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare emailAddress: string;
  declare label: string | null;
  declare vendorHint: string | null;
  declare enabled: CreationOptional<boolean>;
  declare status: CreationOptional<'enabled' | 'suggested' | 'dismissed'>;
  declare source: CreationOptional<'user' | 'discovery'>;
  declare sampleSubject: CreationOptional<string | null>;
  declare candidateCount: CreationOptional<number>;
  declare lastSeenAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initReceiptSenderAllowlist(
  sequelize: Sequelize,
): typeof ReceiptSenderAllowlist {
  ReceiptSenderAllowlist.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      emailAddress: {
        type: DataTypes.STRING(256),
        field: 'email_address',
        allowNull: false,
      },
      label: { type: DataTypes.STRING(128), allowNull: true },
      vendorHint: {
        type: DataTypes.STRING(32),
        field: 'vendor_hint',
        allowNull: true,
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'enabled',
      },
      source: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'user',
      },
      sampleSubject: {
        type: DataTypes.STRING(256),
        field: 'sample_subject',
        allowNull: true,
        defaultValue: null,
      },
      candidateCount: {
        type: DataTypes.INTEGER,
        field: 'candidate_count',
        allowNull: false,
        defaultValue: 0,
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        field: 'last_seen_at',
        allowNull: true,
        defaultValue: null,
      },
    } as ModelAttributes<ReceiptSenderAllowlist>,
    {
      sequelize,
      modelName: 'ReceiptSenderAllowlist',
      tableName: 'receipt_sender_allowlist',
      underscored: true,
      timestamps: true,
    },
  );
  return ReceiptSenderAllowlist;
}
