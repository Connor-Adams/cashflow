import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * Reimbursement claim (issue #216). Tracks money the household expects back
 * for an original outlay `transaction_id` — from a partner, friend, employer,
 * insurer, etc. 1:N with `transactions` (a single outlay can spawn multiple
 * claims), so this model carries its own integer PK rather than reusing
 * `transaction_id` as the PK like the 1:1 sidecars (Purchase,
 * TransactionReturnMetadata).
 *
 * Party is either a structured `contactId` OR free-text `partyName`; routes
 * require at least one. `repaymentTransactionId` links the incoming credit
 * transaction once a repayment is matched.
 *
 * `status` is STRING(16) (not a native enum) so the vocab can grow without a
 * destructive migration. The serializer derives an effective 'overdue' status
 * when status='expected' && dueDate < today, so no cron job is needed; the
 * stored 'overdue' value lets users pin a claim as overdue explicitly.
 */
export type ReimbursementStatus =
  | 'expected'
  | 'received'
  | 'overdue'
  | 'waived';
export const REIMBURSEMENT_STATUSES: readonly ReimbursementStatus[] = [
  'expected',
  'received',
  'overdue',
  'waived',
] as const;

export class Reimbursement extends Model<
  InferAttributes<Reimbursement>,
  InferCreationAttributes<Reimbursement>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare transactionId: number;
  /** Structured party (Contact in same household); null when free-text. */
  declare contactId: number | null;
  /** Free-text party label; null when a Contact is referenced. */
  declare partyName: string | null;
  /** DECIMAL(14,4) returned as a string by sequelize. */
  declare amount: string;
  declare currency: string;
  /** YYYY-MM-DD (DATEONLY); null when no due date set. */
  declare dueDate: string | null;
  declare status: CreationOptional<ReimbursementStatus>;
  /** The incoming credit transaction once a repayment is matched. */
  declare repaymentTransactionId: number | null;
  /** Set when the claim is marked received. */
  declare receivedAt: Date | null;
  declare createdByUserId: number | null;
  declare notes: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initReimbursement(sequelize: Sequelize): typeof Reimbursement {
  Reimbursement.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      transactionId: {
        type: DataTypes.INTEGER,
        field: 'transaction_id',
        allowNull: false,
      },
      contactId: {
        type: DataTypes.INTEGER,
        field: 'contact_id',
        allowNull: true,
      },
      partyName: {
        type: DataTypes.STRING(160),
        field: 'party_name',
        allowNull: true,
      },
      amount: {
        type: DataTypes.DECIMAL(14, 4),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      dueDate: {
        type: DataTypes.DATEONLY,
        field: 'due_date',
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'expected',
      },
      repaymentTransactionId: {
        type: DataTypes.INTEGER,
        field: 'repayment_transaction_id',
        allowNull: true,
      },
      receivedAt: {
        type: DataTypes.DATE,
        field: 'received_at',
        allowNull: true,
      },
      createdByUserId: {
        type: DataTypes.INTEGER,
        field: 'created_by_user_id',
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    } as ModelAttributes<Reimbursement>,
    {
      sequelize,
      modelName: 'Reimbursement',
      tableName: 'reimbursements',
      underscored: true,
      timestamps: true,
    },
  );
  return Reimbursement;
}
