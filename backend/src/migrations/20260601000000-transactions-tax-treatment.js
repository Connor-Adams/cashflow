'use strict';

/**
 * No-op. This migration originally added a `tax_treatment` column for an early
 * version of the income-classification feature. That work was folded onto
 * main's existing `tax_treatment_override` column (added by its own migration),
 * so no schema change is needed here. Kept as a no-op rather than deleted to
 * preserve a contiguous migration history.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up() {
    /* intentionally empty — folded onto tax_treatment_override */
  },
  async down() {
    /* intentionally empty */
  },
};
