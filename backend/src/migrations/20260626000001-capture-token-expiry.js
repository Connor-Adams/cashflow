'use strict';

// Adds a server-side expiry to capture tokens (issue #829). The capture bearer
// token is embedded in cleartext inside the bookmarklet `javascript:` URL and
// lives in the browser's bookmark store, so a leaked bookmark previously granted
// POST /api/capture/orders indefinitely. `expires_at` lets captureAuth reject
// stale tokens. Nullable so pre-existing tokens keep working (no implicit
// expiry); newly minted tokens get an expiry set by the route.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_capture_tokens', 'expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_capture_tokens', 'expires_at');
  },
};
