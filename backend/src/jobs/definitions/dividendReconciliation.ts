import { defineJob } from '../registry';
import * as env from '../../config/env';
import { Household, HouseholdMember } from '../../models';
import { autoMatchDividends, findStaleDividends } from '../../services/dividendMatcher';
import { enqueueNotification } from '../../notifications';
import { Op } from 'sequelize';

defineJob({
  name: 'dividend_reconciliation',
  cronDefault: env.dividendReconcileCron,
  enabledDefault: env.dividendReconcileEnabled,
  handler: async () => {
    const households = await Household.findAll({ attributes: ['id'] });
    let totalMatched = 0;
    let totalStaleNotified = 0;

    for (const hh of households) {
      const matchResult = await autoMatchDividends(hh.id);
      totalMatched += matchResult.matched;

      // Notify household owner(s) about any dividends still unmatched 7+ days past payment.
      const stale = await findStaleDividends(hh.id, 7);
      if (stale.length > 0) {
        const owners = await HouseholdMember.findAll({
          where: { householdId: hh.id, role: { [Op.in]: ['owner', 'admin'] } },
          attributes: ['userId'],
        });
        for (const member of owners) {
          for (const div of stale) {
            await enqueueNotification(member.userId, 'dividend.unmatched', {
              severity: 'warn',
              title: 'Unmatched dividend',
              body: `A dividend payment due ${div.paymentDate ?? div.exDividendDate} has not been matched to a transaction. Visit the Portfolio → Dividends tab to review.`,
              dataJson: { securityDividendId: div.id, securityId: div.securityId },
            }).catch(() => undefined);
          }
        }
        totalStaleNotified += stale.length;
      }
    }

    return {
      summary: {
        households: households.length,
        matched: totalMatched,
        staleNotified: totalStaleNotified,
      },
    };
  },
});
