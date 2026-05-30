import { logger } from '../observability/logger';
import type { FeedbackCategory } from '../feedback/validate';

/**
 * Sanitized outbound payload for an in-app feedback submission (issue #295
 * AC#8). Deliberately carries NO user PII — no email, no userId, no
 * household — only the feedback content and the page/version context, so the
 * webhook can fan out to a GitHub issue / Slack / Linear sink without leaking
 * who submitted it.
 */
export type FeedbackWebhookPayload = {
  id: number;
  category: FeedbackCategory;
  body: string;
  currentPath: string | null;
  appVersion: string | null;
  createdAt: string;
};

/**
 * Fire-and-forget POST to FEEDBACK_WEBHOOK_URL when configured. Never throws:
 * a webhook failure (network error or non-2xx) is logged but must not affect
 * the user's submission, which has already been persisted (issue #295 AC#8).
 * No-op when the env var is unset.
 */
export async function forwardFeedback(
  payload: FeedbackWebhookPayload,
): Promise<void> {
  const url = process.env.FEEDBACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'feedback_webhook_non_ok');
    }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'feedback_webhook_failed',
    );
  }
}
