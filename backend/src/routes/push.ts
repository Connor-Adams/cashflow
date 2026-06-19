/**
 * Web-push subscription routes (issue #651). All endpoints are user-scoped via
 * `currentAuth(req).user.id`; we never accept a userId in the URL or body, so a
 * caller can only ever create/delete their OWN subscription rows.
 *
 * Endpoints:
 *   POST   /api/push/subscriptions   upsert the caller's subscription (idempotent on endpoint)
 *   DELETE /api/push/subscriptions   delete the caller's subscription for an endpoint
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { PushSubscription } from '../models';

const router = Router();

/**
 * Validate + normalize a subscribe body. Pure helper — exported for the unit
 * test. Requires `endpoint`, `keys.p256dh`, and `keys.auth` as non-empty
 * strings; `userAgent` is optional.
 */
export function parseSubscribeBody(
  raw: unknown,
):
  | { ok: true; value: { endpoint: string; p256dh: string; auth: string; userAgent: string | null } }
  | { ok: false; error: string } {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, error: 'body must be an object' };
  }
  const body = raw as Record<string, unknown>;
  const endpoint = body.endpoint;
  const keys = body.keys;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return { ok: false, error: 'endpoint is required' };
  }
  if (keys == null || typeof keys !== 'object') {
    return { ok: false, error: 'keys is required' };
  }
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || p256dh.trim() === '') {
    return { ok: false, error: 'keys.p256dh is required' };
  }
  if (typeof auth !== 'string' || auth.trim() === '') {
    return { ok: false, error: 'keys.auth is required' };
  }
  const userAgent =
    typeof body.userAgent === 'string' && body.userAgent.trim() !== ''
      ? body.userAgent
      : null;
  return { ok: true, value: { endpoint, p256dh, auth, userAgent } };
}

/**
 * Upsert the caller's subscription. Idempotent on `endpoint`: re-subscribing
 * from the same browser updates the existing row (and re-points it at the
 * caller, in case the endpoint was previously owned by someone else on a
 * shared device) rather than creating a duplicate. Returns `201 { id }`.
 */
router.post('/subscriptions', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const parsed = parseSubscribeBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { endpoint, p256dh, auth, userAgent } = parsed.value;

    const existing = await PushSubscription.findOne({ where: { endpoint } });
    let row: PushSubscription;
    if (existing) {
      existing.set('userId', user.id);
      existing.set('p256dh', p256dh);
      existing.set('auth', auth);
      existing.set('userAgent', userAgent);
      await existing.save();
      row = existing;
    } else {
      row = await PushSubscription.create({
        userId: user.id,
        endpoint,
        p256dh,
        auth,
        userAgent,
      });
    }

    res.status(201).json({ id: row.id });
  } catch (e) {
    next(e);
  }
});

/**
 * Delete the caller's subscription for a given endpoint. Scoped by userId so a
 * caller can never delete another user's row. `204` on success, `404` when no
 * matching row owned by the caller exists.
 */
router.delete('/subscriptions', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const endpoint = (req.body as Record<string, unknown> | undefined)?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }

    const deleted = await PushSubscription.destroy({
      where: { endpoint, userId: user.id },
    });
    if (deleted === 0) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
