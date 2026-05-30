'use strict';

/**
 * Adds `optional_email` to `household_invites` for #281 (household invite UI).
 *
 * The Members settings tab lets a user attach an optional email to an invite
 * purely for their own record-keeping ("who did I send this to?"). It is NOT
 * used to send mail in v1 — automatic invite delivery is a separate
 * notification-channel concern (explicitly out of scope on the issue).
 *
 * Nullable VARCHAR(255): existing invites predate the column and legacy
 * `POST /api/auth/invites` never sets it, so NULL must be allowed.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('household_invites', 'optional_email', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('household_invites', 'optional_email');
  },
};
