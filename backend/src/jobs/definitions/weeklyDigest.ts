/**
 * Weekly digest scheduled job (issue #267).
 *
 * Mondays 09:00 UTC by default — picks up every user whose
 * `last_digest_sent_at` is NULL or older than 6 days, has at least one
 * `notification_preferences` channel enabled for `digest.weekly` (with
 * implicit defaults if no row exists: in-app on, email off), and has at
 * least one transaction in their account history (AC #11).
 *
 * Per-user error isolation (AC #9): any throw inside the per-user step is
 * caught, logged, and the next user proceeds. `last_digest_sent_at` is only
 * updated on success (AC #10).
 */
import { Op } from 'sequelize';
import { defineJob } from '../registry';
import * as env from '../../config/env';
import { logger } from '../../observability/logger';
import { User } from '../../models';
import { runWeeklyDigest } from '../../notifications/runWeeklyDigest';

defineJob({
  name: 'weekly_digest',
  cronDefault: env.weeklyDigestCron,
  enabledDefault: env.weeklyDigestEnabled,
  handler: async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    // Eligibility: never sent OR sent more than 6 days ago.
    const eligible = await User.findAll({
      where: {
        [Op.or]: [
          { lastDigestSentAt: null },
          { lastDigestSentAt: { [Op.lt]: sixDaysAgo } },
        ],
      },
      attributes: ['id', 'email', 'displayName', 'lastDigestSentAt'],
    });

    const result = await runWeeklyDigest(eligible, new Date());

    logger.info(
      {
        eligible: eligible.length,
        processed: result.processed,
        sentEmail: result.sentEmail,
        wroteInApp: result.wroteInApp,
        skippedNoHistory: result.skippedNoHistory,
        skippedMuted: result.skippedMuted,
        errors: result.errors,
      },
      'weekly_digest_run',
    );
    return {
      summary: {
        eligible: eligible.length,
        processed: result.processed,
        sentEmail: result.sentEmail,
        wroteInApp: result.wroteInApp,
        skippedNoHistory: result.skippedNoHistory,
        skippedMuted: result.skippedMuted,
        emailFailures: result.emailFailures,
        errors: result.errors,
      },
    };
  },
});
