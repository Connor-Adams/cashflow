/**
 * Daily dividend reconciliation job (#305).
 *
 * Runs at 04:00 UTC every day. For each SecurityDividend where:
 * - paymentDate is in the past 90 days
 * - matchedTransactionId IS NULL
 * - paymentDate IS NOT NULL
 *
 * Determines holdingShares from HoldingSnapshot, calls autoMatchDividend,
 * and if a match is found sets matched_transaction_id + matched_at.
 */
import { Op } from 'sequelize';
import { defineJob } from '../registry';
import { logger } from '../../observability/logger';
import { HoldingSnapshot, SecurityDividend, Security } from '../../models';
import { autoMatchDividend } from '../../services/dividendMatcher';

defineJob({
  name: 'dividend_reconciliation',
  cronDefault: '0 4 * * *',
  enabledDefault: true,
  handler: async () => {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90);
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const dividends = await SecurityDividend.findAll({
      where: {
        matchedTransactionId: null,
        paymentDate: {
          [Op.not]: null,
          [Op.gte]: ninetyDaysAgoStr,
          [Op.lt]: todayStr,
        },
      },
    });

    let matched = 0;
    let skipped = 0;
    let errors = 0;

    for (const dividend of dividends) {
      try {
        if (!dividend.paymentDate) {
          skipped++;
          continue;
        }

        // Look up the security for its symbol (used in description heuristic)
        const security = await Security.findByPk(dividend.securityId);

        // Find the latest holding snapshot at or before paymentDate
        const snapshot = await HoldingSnapshot.findOne({
          where: {
            securityId: dividend.securityId,
            statementDate: { [Op.lte]: dividend.paymentDate },
          },
          order: [
            ['statementDate', 'DESC'],
            ['id', 'DESC'],
          ],
        });

        if (!snapshot) {
          skipped++;
          continue;
        }

        const holdingShares = Number(snapshot.quantity);
        if (!Number.isFinite(holdingShares) || holdingShares <= 0) {
          skipped++;
          continue;
        }

        const matchedId = await autoMatchDividend(dividend, holdingShares, security);
        if (matchedId != null) {
          await dividend.update({
            matchedTransactionId: matchedId,
            matchedAt: new Date(),
          });
          matched++;
          logger.info(
            { dividendId: dividend.id, transactionId: matchedId },
            'dividend_auto_matched',
          );
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        logger.warn(
          { err, dividendId: dividend.id },
          'dividend_reconciliation_row_failed',
        );
      }
    }

    logger.info(
      { total: dividends.length, matched, skipped, errors },
      'dividend_reconciliation_run',
    );

    return { summary: { total: dividends.length, matched, skipped, errors } };
  },
});
