/**
 * Weekly digest scheduled job (issue #267, #796).
 *
 * Daily 09:00 UTC by default (#796) — picks up every user whose
 * `last_digest_sent_at` is NULL or older than 6 days, has at least one
 * `notification_preferences` channel enabled for `digest.weekly` (with
 * implicit defaults if no row exists: in-app on, email off, push off), and has
 * at least one transaction in their account history (AC #11). The per-user
 * `digestDayOfWeek` is enforced inside `runWeeklyDigest`, so the daily tick
 * only delivers to users whose chosen weekday matches today; the 6-day
 * eligibility guard keeps it to one digest per ~week.
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
        sentPush: result.sentPush,
        wroteInApp: result.wroteInApp,
        skippedNoHistory: result.skippedNoHistory,
        skippedMuted: result.skippedMuted,
        skippedWrongDay: result.skippedWrongDay,
        errors: result.errors,
      },
      'weekly_digest_run',
    );
    return {
      summary: {
        eligible: eligible.length,
        processed: result.processed,
        sentEmail: result.sentEmail,
        sentPush: result.sentPush,
        wroteInApp: result.wroteInApp,
        skippedNoHistory: result.skippedNoHistory,
        skippedMuted: result.skippedMuted,
        skippedWrongDay: result.skippedWrongDay,
        emailFailures: result.emailFailures,
        pushFailures: result.pushFailures,
        errors: result.errors,
      },
    };
  },
});
