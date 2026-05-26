import { detectMissingSlips } from './missingSlipDetector';
import { detectSlipDivergence } from './slipDivergenceDetector';
import { detectCategoryMisclass } from './categoryMisclassDetector';
import type {
  ReconciliationCategory,
  ReconciliationFinding,
  ReconciliationReport,
} from './types';

const ALL_CATEGORIES: ReconciliationCategory[] = [
  'missing_slip',
  'slip_divergence',
  'category_misclass',
];

export async function buildReconciliationReport(
  entityId: number,
  year: number,
): Promise<ReconciliationReport> {
  const [missing, divergence, misclass] = await Promise.all([
    detectMissingSlips(entityId, year),
    detectSlipDivergence(entityId, year),
    detectCategoryMisclass(entityId, year),
  ]);

  const findings: ReconciliationFinding[] = [...missing, ...divergence, ...misclass];

  const counts = ALL_CATEGORIES.reduce<Record<ReconciliationCategory, number>>(
    (acc, cat) => {
      acc[cat] = findings.filter((f) => f.category === cat).length;
      return acc;
    },
    { missing_slip: 0, slip_divergence: 0, category_misclass: 0 },
  );

  return {
    entityId,
    year,
    generatedAt: new Date().toISOString(),
    findings,
    counts,
  };
}
