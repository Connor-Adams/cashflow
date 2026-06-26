/**
 * Web-push send wrapper (issue #651).
 *
 * Owns the VAPID configuration and the fan-out of a single notification
 * payload to all of a user's active push subscriptions, plus the dead-endpoint
 * pruning contract: when the push service reports an endpoint is gone (HTTP
 * 404/410), that `push_subscriptions` row is deleted so we stop trying it.
 *
 * The actual network send is injected (`sendImpl`) so tests can drive fan-out,
 * success, and 410-pruning deterministically without a real push service or
 * the `web-push` library's global VAPID state. Production wires the real
 * `web-push` send via `defaultWebPushSender`.
 */
import webpush from 'web-push';
// Import the model class directly (NOT the `../models` barrel): the barrel runs
// `initX(globalSequelize)` at import time, which would rebind already-init'd
// model classes off any private test sequelize. Importing the class file alone
// has no init side-effect. The class is bound to a sequelize by the app's
// models/index bootstrap (or a test's own init).
import { PushSubscription } from '../models/PushSubscription';
import * as env from '../config/env';

/** The browser-supplied subscription shape `web-push` expects. */
export type WebPushTarget = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** Serialized payload pushed to the browser's service-worker `push` handler. */
export type WebPushPayload = {
  title: string;
  body: string;
  severity?: string;
  dataJson?: Record<string, unknown> | null;
};

/**
 * Result of a single endpoint send. `gone` signals the endpoint should be
 * pruned (push service returned 404/410). `failed` is a transient/other error
 * — we keep the row and move on.
 */
export type SendOutcome = 'sent' | 'gone' | 'failed';

/**
 * Low-level send for one endpoint. Returns the outcome; never throws. The
 * production impl maps the `web-push` library's `WebPushError.statusCode` to
 * the outcome; tests inject their own.
 */
export type WebPushSender = (
  target: WebPushTarget,
  payloadJson: string,
) => Promise<SendOutcome>;

/**
 * Host suffixes of the four browser push services we accept subscriptions for.
 * Matched as a suffix against the endpoint hostname (with a leading-dot guard so
 * `evilgoogleapis.com` can't pass `googleapis.com`). This is the SSRF allowlist
 * for issue #855: without it, an authenticated user could register an endpoint
 * pointing at `169.254.169.254` or `localhost`, and the push fan-out would issue
 * an outbound POST to that internal address on the next notification.
 *   - FCM (Chrome/Edge/Android): *.fcm.googleapis.com
 *   - Mozilla (Firefox):          updates.push.services.mozilla.com
 *   - WNS (legacy Edge/Windows):  *.notify.windows.com
 *   - Apple (Safari):             web.push.apple.com
 */
const ALLOWED_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'web.push.apple.com',
] as const;

/**
 * True when `endpoint` is a well-formed `https:` URL whose host is one of the
 * known push services. Used by the subscribe route (reject at registration) and
 * re-checked in `defaultWebPushSender` (defense-in-depth before the outbound
 * send). Anything else — non-https, malformed, internal/metadata hosts, or an
 * unknown public host — returns false.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** True when both VAPID keys are configured — push is otherwise a no-op. */
export function isPushConfigured(): boolean {
  return Boolean(env.vapidPublicKey && env.vapidPrivateKey);
}

let vapidApplied = false;

/**
 * Production sender backed by the `web-push` library. Configures VAPID once
 * (lazily) and maps gone-endpoint status codes to the prune signal.
 */
export const defaultWebPushSender: WebPushSender = async (target, payloadJson) => {
  if (!isPushConfigured()) return 'failed';
  // Defense-in-depth (issue #855): even though the subscribe route allowlists
  // the host, re-validate before issuing the outbound request so a row that
  // predates the allowlist (or was written via another path) can never trigger
  // an SSRF. A non-allowlisted endpoint is a permanent failure → prune it.
  if (!isAllowedPushEndpoint(target.endpoint)) return 'gone';
  if (!vapidApplied) {
    webpush.setVapidDetails(
      env.vapidSubject,
      env.vapidPublicKey as string,
      env.vapidPrivateKey as string,
    );
    vapidApplied = true;
  }
  try {
    await webpush.sendNotification(target, payloadJson);
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number } | null)?.statusCode;
    if (status === 404 || status === 410) return 'gone';
    return 'failed';
  }
};

/**
 * Fan a single notification payload out to every active push subscription
 * the user owns. For each endpoint reported `gone` (404/410), delete that
 * `push_subscriptions` row; the remaining endpoints still receive the push
 * (AC #6). Returns counts for observability/tests.
 *
 * No-ops (returns zeroed counts) when VAPID is unconfigured, so callers don't
 * need to guard. Never throws — a push failure must never break the in-app
 * notification write that triggered it.
 */
export async function fanOutWebPush(
  userId: number,
  payload: WebPushPayload,
  sender: WebPushSender = defaultWebPushSender,
): Promise<{ sent: number; pruned: number; failed: number }> {
  if (!isPushConfigured()) {
    return { sent: 0, pruned: 0, failed: 0 };
  }

  const subs = await PushSubscription.findAll({ where: { userId } });
  if (subs.length === 0) {
    return { sent: 0, pruned: 0, failed: 0 };
  }

  const payloadJson = JSON.stringify({
    title: payload.title,
    body: payload.body,
    severity: payload.severity ?? 'info',
    dataJson: payload.dataJson ?? null,
  });

  let sent = 0;
  let pruned = 0;
  let failed = 0;

  for (const sub of subs) {
    const target: WebPushTarget = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    let outcome: SendOutcome;
    try {
      outcome = await sender(target, payloadJson);
    } catch {
      // A sender that throws is treated as a transient failure — keep the row.
      outcome = 'failed';
    }
    if (outcome === 'sent') {
      sent += 1;
    } else if (outcome === 'gone') {
      pruned += 1;
      await sub.destroy();
    } else {
      failed += 1;
    }
  }

  return { sent, pruned, failed };
}
