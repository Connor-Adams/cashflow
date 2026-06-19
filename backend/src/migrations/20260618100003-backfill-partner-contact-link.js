'use strict';

module.exports = {
  async up(queryInterface) {
    const sql = `
      SELECT c.id AS contact_id, m.user_id AS user_id
      FROM contacts c
      JOIN (
        SELECT household_id, COUNT(*) AS member_count, MIN(user_id) AS user_id
        FROM household_members
        WHERE role <> 'owner'
        GROUP BY household_id
        HAVING COUNT(*) = 1
      ) m ON m.household_id = c.household_id
      WHERE c.is_partner = true AND c.user_id IS NULL
      AND (
        SELECT COUNT(*) FROM contacts c2
        WHERE c2.household_id = c.household_id AND c2.is_partner = true AND c2.user_id IS NULL
      ) = 1
    `;
    const [rows] = await queryInterface.sequelize.query(sql);
    for (const row of rows) {
      await queryInterface.sequelize.query(
        'UPDATE contacts SET user_id = :userId WHERE id = :contactId',
        { replacements: { userId: row.user_id, contactId: row.contact_id } },
      );
    }
  },

  async down() {
    // No-op: backfill is not reversible (we cannot tell which links were backfilled
    // vs set by the invite-accept hook). Safe to leave links in place.
  },
};
