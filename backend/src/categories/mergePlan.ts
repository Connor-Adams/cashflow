/**
 * Typed facade over `backend/lib/categoryMergePlan.js`.
 *
 * The implementation is plain CommonJS outside `src/` because the migration
 * needs the identical function and `sequelize-cli` loads migrations as plain JS
 * with no TypeScript pipeline. `src/categories/` and `dist/categories/` sit at
 * the same depth under `backend/`, so this one relative path resolves the same
 * way from the source tree, the build output, and `src/migrations/`.
 */
import categoryMergePlan = require('../../lib/categoryMergePlan');

export const planCategoryMerges = categoryMergePlan.planCategoryMerges;
export const subtreeNames = categoryMergePlan.subtreeNames;
export type { PlanCategory, PlanBudget } from '../../lib/categoryMergePlan';
