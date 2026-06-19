'use strict';
/**
 * merchant_embeddings: a household-scoped memoization cache of one embedding
 * vector per distinct merchant_clean per embedding model. The vector is a pure,
 * deterministic function of (merchant_clean, model) — fully recomputable, holds
 * no independent state, so it is NOT a primitive: it is a derived cache layer
 * (issue #792). Cosine similarity is computed in JS over the household's
 * vectors, so the embedding is stored as JSON-encoded text to stay dual-dialect
 * (SQLite + Postgres) without pgvector.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('merchant_embeddings', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      merchant_clean: { type: Sequelize.TEXT, allowNull: false },
      embedding: { type: Sequelize.TEXT, allowNull: false },
      dim: { type: Sequelize.INTEGER, allowNull: false },
      model: { type: Sequelize.STRING(128), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    // One cached vector per household + merchant + model. The cache lookup hits
    // this index, and it prevents duplicate embeds.
    await queryInterface.addIndex('merchant_embeddings', ['household_id', 'merchant_clean', 'model'], {
      unique: true,
      name: 'merchant_embeddings_household_merchant_model_uniq',
    });
    // "Load all of this household's vectors" scan used by the similarity pass.
    await queryInterface.addIndex('merchant_embeddings', ['household_id'], {
      name: 'merchant_embeddings_household_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('merchant_embeddings');
  },
};
