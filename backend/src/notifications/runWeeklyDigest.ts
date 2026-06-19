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
import { buildDigestPush } from './digestPush';
import { sendEmail } from './mailer';
import { fanOutWebPush, type WebPushSender } from './webPush';

export const WEEKLY_DIGEST_TYPE = 'digest.weekly' as const;

export interface WeeklyDigestRunResult {
  processed: number;
  sentEmail: number;
  wroteInApp: number;
  /** Users who received a web-push fan-out (≥1 endpoint sent). */
  sentPush: number;
  /** Users whose entire history was empty — both channels skipped. */
  skippedNoHistory: number;
  /** Users with all channels muted — fully opted out. */
  skippedMuted: number;
  /** Users skipped because their chosen send day ≠ this tick's weekday. */
  skippedWrongDay: number;
  /** Users where the email send (after retries) failed. */
  emailFailures: number;
  /** Users where the push fan-out threw (counted, never blocks other channels). */
  pushFailures: number;
  errors: number;
}

interface ProcessableUser {
  id: number;
  email: string;
  displayName: string;
}

interface DigestPref {
  channelInApp: boolean;
  channelEmail: boolean;
  channelPush: boolean;
  digestDayOfWeek: number;
}

async function resolvePref(userId: number): Promise<DigestPref> {
  const row = await NotificationPreference.findOne({
    where: { userId, type: WEEKLY_DIGEST_TYPE },
  });
  if (row) {
    return {
      channelInApp: row.channelInApp,
      channelEmail: row.channelEmail,
      channelPush: row.channelPush,
      digestDayOfWeek: row.digestDayOfWeek,
    };
  }
  return {
    channelInApp: NOTIFICATION_PREFERENCE_DEFAULTS.channelInApp,
    channelEmail: NOTIFICATION_PREFERENCE_DEFAULTS.channelEmail,
    channelPush: NOTIFICATION_PREFERENCE_DEFAULTS.channelPush,
    digestDayOfWeek: NOTIFICATION_PREFERENCE_DEFAULTS.digestDayOfWeek,
  };
}

/**
 * Build the structured, persisted digest payload (#796). Rides on the existing
 * open-shape `Notification.dataJson` column — no new table. The expandable
 * frontend card reads every section from here with no follow-up request.
 * `link` deep-links a push/dashboard click to the expanded dashboard card.
 */
export function buildDigestDataJson(
  data: WeeklyDigestData,
): Record<string, unknown> {
  return {
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    currency: data.currency,
    totalSpend: data.totalSpend,
    priorTotalSpend: data.priorTotalSpend,
    totalIncome: data.totalIncome,
    priorTotalIncome: data.priorTotalIncome,
    netChange: data.netChange,
    // Kept for backward-compat with digests persisted before #796.
    topCategory: data.topCategories[0]?.category ?? null,
    categoryDeltas: data.categoryDeltas.map((c) => ({
      category: c.category,
      currency: c.currency,
      total: c.total,
      priorTotal: c.priorTotal,
      delta: c.delta,
    })),
    openInsightCount: data.openInsightCount,
    topInsights: data.topInsights,
    upcomingExpectations: data.upcomingExpectations,
    link: '/?digest=expand',
  };
}

async function maybeWriteInAppRow(
  userId: number,
  data: WeeklyDigestData,
): Promise<Notification | null> {
  // The empty-week branch suppresses the in-app row per issue spec — there's
  // nothing useful to show.
  if (data.isEmptyWeek) return null;
  const rendered = renderWeeklyDigest(data);
  const notif = await Notification.create({
    userId,
    type: WEEKLY_DIGEST_TYPE,
    severity: 'info',
    title: rendered.inAppTitle,
    body: rendered.inAppBody,
    dataJson: buildDigestDataJson(data),
  });
  return notif;
}

/**
 * Fire web-push for the digest (#796 AC6/AC10). Best-effort and isolated: a
 * thrown fan-out is caught and reported as a failure, never blocking the
 * in-app/email channels. Returns whether ≥1 endpoint was actually sent and
 * whether the attempt failed. Title/body follow the issue's copy templates and
 * deep-link to the expanded dashboard digest card.
 */
async function maybeSendPush(
  userId: number,
  data: WeeklyDigestData,
  pushSender?: WebPushSender,
): Promise<{ sent: boolean; failed: boolean }> {
  const push = buildDigestPush(data);
  try {
    const res = await fanOutWebPush(
      userId,
      {
        title: push.title,
        body: push.body,
        severity: 'info',
        dataJson: buildDigestDataJson(data),
      },
      pushSender,
    );
    return { sent: res.sent > 0, failed: false };
  } catch (err) {
    logger.error({ err, userId }, 'weekly_digest_push_failed');
    return { sent: false, failed: true };
  }
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

export interface RunWeeklyDigestOptions {
  /**
   * Injectable web-push transport so tests can drive (or fail) the fan-out
   * deterministically without VAPID/real endpoints. Production omits it and
   * the default sender is used.
   */
  pushSender?: WebPushSender;
  /**
   * Bypass the per-user `digestDayOfWeek` gate (#796). The scheduled cron
   * leaves this false so each user only fires on their chosen weekday; the
   * admin "run-now" / generate-now path sets it true because it's an explicit
   * manual trigger that should deliver regardless of the current weekday.
   */
  ignoreDayOfWeek?: boolean;
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
  options: RunWeeklyDigestOptions = {},
): Promise<WeeklyDigestRunResult> {
  const { pushSender, ignoreDayOfWeek = false } = options;
  const result: WeeklyDigestRunResult = {
    processed: 0,
    sentEmail: 0,
    wroteInApp: 0,
    sentPush: 0,
    skippedNoHistory: 0,
    skippedMuted: 0,
    skippedWrongDay: 0,
    emailFailures: 0,
    pushFailures: 0,
    errors: 0,
  };

  // The tick's weekday (0=Sun … 6=Sat), UTC-anchored to match
  // computeReportingWeek. Per-user day-of-week is enforced against this.
  const tickDayOfWeek = asOf.getUTCDay();

  for (const user of users) {
    try {
      const pref = await resolvePref(user.id);
      if (!pref.channelInApp && !pref.channelEmail && !pref.channelPush) {
        result.skippedMuted += 1;
        continue;
      }

      // Day-of-week gate (#796 AC8): a user whose chosen day ≠ today's weekday
      // is skipped this tick and left eligible (last_digest_sent_at untouched).
      // The manual run-now path bypasses this (ignoreDayOfWeek).
      if (!ignoreDayOfWeek && pref.digestDayOfWeek !== tickDayOfWeek) {
        result.skippedWrongDay += 1;
        continue;
      }

      const data = await buildDigestForUser(user.id, asOf);
      if (!data) {
        // No history at all — skip all channels (AC #11) and DO NOT
        // touch last_digest_sent_at so they pick up next week if they
        // import data in between.
        result.skippedNoHistory += 1;
        continue;
      }

      let didAnything = false;
      if (pref.channelInApp) {
        const notif = await maybeWriteInAppRow(user.id, data);
        if (notif) {
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
      // Web-push (#796): independent of the in-app/email outcome and never
      // blocks them. Suppress on an empty week to match the in-app suppression.
      if (pref.channelPush && !data.isEmptyWeek) {
        const out = await maybeSendPush(user.id, data, pushSender);
        if (out.sent) {
          result.sentPush += 1;
          didAnything = true;
        }
        if (out.failed) {
          result.pushFailures += 1;
        }
      }

      // "Processed" means we did at least one channel's work (in-app written,
      // email sent, or push sent). An empty-week with only channelInApp on
      // skips the in-app write and is not "processed" — intentional; we leave
      // them eligible until they have something to say.
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
