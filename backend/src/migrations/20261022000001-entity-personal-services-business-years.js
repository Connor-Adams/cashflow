'use strict';
/**
 * Tax years in which a corporation's business is a personal services business
 * (ITA s.125(7)). PSB status turns on each year's facts, so it is a per-year
 * attribute of the corp entity: a list of tax years (fiscal-year-end year), not
 * a single flag. buildCorpFacts reads it to tax that year's active business
 * income at the PSB rate and deny its expenses under s.18(1)(p).
 */
const { dropColumn } = require('./helpers/sqliteDropColumn');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tax_entities', 'personal_services_business_years', {
      type: Sequelize.JSON,
      allowNull: false,
      defaultValue: [],
    });
  },
  async down(queryInterface) {
    await dropColumn(queryInterface, 'tax_entities', 'personal_services_business_years');
  },
};
