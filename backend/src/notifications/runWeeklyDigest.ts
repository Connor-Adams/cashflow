/**
 * Per-tick orchestrator for the weekly digest (issue #267). Pulled out of
 * `jobs/definitions/weeklyDigest.ts` so it can be unit-tested without
 * registering a cron — tests construct user fixtures, call this function
 * directly, and assert on its `WeeklyDigestRunResult`.
 *
 * Contract:
 *   - Per-user errors are caught + counted; one user's failure never
 *     blocks the rest.
 *   - `last_digest_sent_at` is only updated when a user is "processed"
 *     (i.e. we successfully aggregated + delivered to at least one
 *     channel). Users skipped for no-history or fully-muted are left
 *     untouched so they're picked up next week.
 *   - When email is requested by preference but the user has no `email`
 *     column, the email step is skipped (logged) and we still do in-app
 *     if that channel is on.
 *   - The mailer's own retry semantics are honored; this function does NOT
 *     re-retry on top of them.
 */
import {
  Notification,
  NotificationPreference,
  User,
} from '../models';
import { NOTIFICATION_PREFERENCE_DEFAULTS } from '../models/NotificationPreference';
import { logger } from '../observability/logger';
import { buildDigestForUser, type WeeklyDigestData } from './digest';
import { renderWeeklyDigest } from './templates/weeklyDigest';
import { sendEmail } from './mailer';

export const WEEKLY_DIGEST_TYPE = 'digest.weekly' as const;

export interface WeeklyDigestRunResult {
  processed: number;
  sentEmail: number;
  wroteInApp: number;
  /** Users whose entire history was empty — both channels skipped. */
  skippedNoHistory: number;
  /** Users with both channels muted — fully opted out. */
  skippedMuted: number;
  /** Users where the email send (after retries) failed. */
  emailFailures: number;
  errors: number;
}

interface ProcessableUser {
  id: number;
  email: string;
  displayName: string;
}

async function resolvePref(userId: number): Promise<{
  channelInApp: boolean;
  channelEmail: boolean;
}> {
  const row = await NotificationPreference.findOne({
    where: { userId, type: WEEKLY_DIGEST_TYPE },
  });
  if (row) {
    return {
      channelInApp: row.channelInApp,
      channelEmail: row.channelEmail,
    };
  }
  return {
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
  };
}

async function maybeWriteInAppRow(
  userId: number,
  data: WeeklyDigestData,
): Promise<boolean> {
  // The empty-week branch suppresses the in-app row per issue spec — there's
  // nothing useful to show.
  if (data.isEmptyWeek) return false;
  const rendered = renderWeeklyDigest(data);
  await Notification.create({
    userId,
    type: WEEKLY_DIGEST_TYPE,
    severity: 'info',
    title: rendered.inAppTitle,
    body: rendered.inAppBody,
    dataJson: {
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,
      totalSpend: data.totalSpend,
      totalIncome: data.totalIncome,
      currency: data.currency,
      topCategory: data.topCategories[0]?.category ?? null,
    },
  });
  return true;
}

async function maybeSendEmail(
  user: ProcessableUser,
  data: WeeklyDigestData,
): Promise<{ sent: boolean; failed: boolean }> {
  if (!user.email || !/.+@.+\..+/.test(user.email)) {
    logger.warn(
      { userId: user.id },
      'weekly_digest_skip_email_no_address',
    );
    return { sent: false, failed: false };
  }
  const rendered = renderWeeklyDigest(data);
  const res = await sendEmail({
    to: user.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  if (!res.ok) {
    logger.error(
      {
        userId: user.id,
        attempts: res.attempts,
        driver: res.driver,
        error: res.error,
      },
      'weekly_digest_email_failed',
    );
    return { sent: false, failed: true };
  }
  return { sent: true, failed: false };
}

/**
 * Iterate the supplied list of users (already filtered for "due") and
 * deliver each one's digest. Updates `last_digest_sent_at` on success.
 *
 * `asOf` is exposed so tests can pin time-of-day; production passes
 * `new Date()`.
 */
export async function runWeeklyDigest(
  users: ProcessableUser[],
  asOf: Date,
): Promise<WeeklyDigestRunResult> {
  const result: WeeklyDigestRunResult = {
    processed: 0,
    sentEmail: 0,
    wroteInApp: 0,
    skippedNoHistory: 0,
    skippedMuted: 0,
    emailFailures: 0,
    errors: 0,
  };

  for (const user of users) {
    try {
      const pref = await resolvePref(user.id);
      if (!pref.channelInApp && !pref.channelEmail) {
        result.skippedMuted += 1;
        continue;
      }

      const data = await buildDigestForUser(user.id, asOf);
      if (!data) {
        // No history at all — skip both channels (AC #11) and DO NOT
        // touch last_digest_sent_at so they pick up next week if they
        // import data in between.
        result.skippedNoHistory += 1;
        continue;
      }

      let didAnything = false;
      if (pref.channelInApp) {
        const wrote = await maybeWriteInAppRow(user.id, data);
        if (wrote) {
          result.wroteInApp += 1;
          didAnything = true;
        }
      }
      if (pref.channelEmail) {
        const out = await maybeSendEmail(user, data);
        if (out.sent) {
          result.sentEmail += 1;
          didAnything = true;
        }
        if (out.failed) {
          result.emailFailures += 1;
        }
      }

      // "Processed" means we did at least one channel's work (in-app or
      // email-sent). An empty-week with channelInApp=true but channelEmail
      // off will skip the in-app write and not be "processed" — that's
      // intentional, we leave them eligible until they have something to say.
      if (didAnything) {
        await User.update(
          { lastDigestSentAt: asOf },
          { where: { id: user.id } },
        );
        result.processed += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.error(
        { err, userId: user.id },
        'weekly_digest_user_failed',
      );
      // Continue to the next user — AC #9.
    }
  }

  return result;
}
