/**
 * Typed facade over `backend/lib/merchantNormalization.js`.
 *
 * The implementation is plain CommonJS outside `src/` because Sequelize
 * migrations need the identical function and `sequelize-cli` loads them as
 * plain JS with no TypeScript pipeline. `src/import/` and `dist/import/` are at
 * the same depth under `backend/`, so this one relative path resolves the same
 * way from the source tree and from the build output. See the header of
 * `backend/lib/merchantNormalization.js` for the full rationale.
 */
import merchantNormalization = require('../../lib/merchantNormalization');

export const normalizeMerchant = merchantNormalization.normalizeMerchant;
