import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import type { FeedbackCategory } from '../feedback/validate';

/**
 * In-app feedback / bug report (issue #295). Each row is a single submission
 * from a user — a bug, feature request, "this is confusing", or other note —
 * captured without leaving the app, with the page URL, browser, and app
 * version included for context.
 *
 * Scoped to both a `user_id` (the submitter, per the issue data model) and a
 * `household_id` so the owner-only inbox can list via householdWhere(req) the
 * same way as every other household-scoped collection.
 *
 * `category` is STRING(32) (not a native enum) so the vocab can grow without a
 * destructive migration; the route validates it against FEEDBACK_CATEGORIES.
 * `resolved_at` is null until the owner marks the item resolved.
 *
 * FK delete semantics:
 *   user_id      CASCADE — feedback is meaningless once its author is removed
 *   household_id CASCADE — household teardown removes its data
 */
export class Feedback extends Model<
  InferAttributes<Feedback>,
  InferCreationAttributes<Feedback>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare userId: number;
  declare category: FeedbackCategory;
  declare body: string;
  /** Page the user was on when submitting; null when not supplied. */
  declare currentPath: string | null;
  /** Request User-Agent header, captured server-side; null when absent. */
  declare userAgent: string | null;
  /** Frontend app version string; null when not supplied. */
  declare appVersion: string | null;
  /** Set when the owner marks the submission resolved. */
  declare resolvedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initFeedback(sequelize: Sequelize): typeof Feedback {
  Feedback.init(
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
        allowNull: false,
      },
      category: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      currentPath: {
        type: DataTypes.STRING(512),
        field: 'current_path',
        allowNull: true,
      },
      userAgent: {
        type: DataTypes.STRING(512),
        field: 'user_agent',
        allowNull: true,
      },
      appVersion: {
        type: DataTypes.STRING(64),
        field: 'app_version',
        allowNull: true,
      },
      resolvedAt: {
        type: DataTypes.DATE,
        field: 'resolved_at',
        allowNull: true,
      },
    } as ModelAttributes<Feedback>,
    {
      sequelize,
      modelName: 'Feedback',
      tableName: 'feedback',
      underscored: true,
      timestamps: true,
    },
  );
  return Feedback;
}
