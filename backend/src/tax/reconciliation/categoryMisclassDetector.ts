import { Op } from 'sequelize';
import { Account, InvestmentActivity, Security } from '../../models';
import type { ReconciliationFinding } from './types';

/**
 * Detect dividend activities whose Security has `dividendEligibility = 'unknown'`,
 * meaning the engine routed them as eligible by default but the user should
 * confirm. Initial scope of category-misclassification detection.
 */
export async function detectCategoryMisclass(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return findings;

  const activities = await InvestmentActivity.findAll({
    where: {
      accountId: accountIds,
      activityType: 'dividend',
      tradeDate: { [Op.between]: [yearStart, yearEnd] },
    },
    include: [{ model: Security, as: 'security' }],
  });

  for (const a of activities) {
    const security = (a as unknown as {
      security?: { symbol?: string; dividendEligibility?: string };
    }).security;
    const eligibility = security?.dividendEligibility ?? 'unknown';
    if (eligibility === 'unknown') {
      findings.push({
        category: 'category_misclass',
        severity: 'info',
        subjectRef: `${security?.symbol ?? '?'} dividend on ${a.tradeDate}`,
        message:
          `Dividend from ${security?.symbol ?? 'unknown security'} has ` +
          `dividendEligibility='unknown'. Defaulted to eligible — confirm or set explicitly.`,
        details: {
          securityId: a.securityId,
          symbol: security?.symbol,
          tradeDate: a.tradeDate,
          activityId: a.id,
        },
      });
    }
  }

  return findings;
}
