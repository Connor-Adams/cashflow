'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    // 1 Personal entity per household, named "Personal".
    const [households] = await sequelize.query('SELECT id FROM households');
    for (const h of households) {
      const [existing] = await sequelize.query(
        `SELECT id FROM tax_entities WHERE household_id = :hid AND kind = 'personal'`,
        { replacements: { hid: h.id } }
      );
      let entityId;
      if (existing.length > 0) {
        entityId = existing[0].id;
      } else {
        const now = new Date().toISOString();
        const [insertResult] = await sequelize.query(
          `INSERT INTO tax_entities (household_id, kind, legal_name, jurisdiction, created_at, updated_at)
           VALUES (:hid, 'personal', 'Personal', 'CA-ON', :now, :now)
           RETURNING id`,
          { replacements: { hid: h.id, now } }
        );
        // SQLite RETURNING fallback
        if (Array.isArray(insertResult) && insertResult[0]?.id != null) {
          entityId = insertResult[0].id;
        } else {
          const [lookup] = await sequelize.query(
            `SELECT id FROM tax_entities WHERE household_id = :hid AND kind = 'personal'`,
            { replacements: { hid: h.id } }
          );
          entityId = lookup[0].id;
        }
      }
      // Assign all accounts in household to this entity if entity_id is null.
      await sequelize.query(
        `UPDATE accounts SET entity_id = :eid WHERE household_id = :hid AND entity_id IS NULL`,
        { replacements: { eid: entityId, hid: h.id } }
      );
      // Propagate to transactions via account_id join.
      await sequelize.query(
        `UPDATE transactions
            SET entity_id = :eid
          WHERE entity_id IS NULL
            AND account_id IN (SELECT id FROM accounts WHERE household_id = :hid)`,
        { replacements: { eid: entityId, hid: h.id } }
      );
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('UPDATE transactions SET entity_id = NULL');
    await sequelize.query('UPDATE accounts SET entity_id = NULL');
    await sequelize.query(`DELETE FROM tax_entities WHERE kind = 'personal' AND legal_name = 'Personal'`);
  },
};
