/**
 * Gmail / email-integration routes.
 *
 *   GET  /api/email/status           — current connection state for the caller
 *   GET  /api/email/auth/google      — redirects to Google's OAuth consent screen
 *   GET  /api/email/callback/google  — Google redirects here with ?code= and ?state=
 *   POST /api/email/disconnect/google — revoke + delete the integration row
 *   POST /api/email/scan/google      — manually trigger a receipt scan
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { UserEmailIntegration } from '../models';
import {
  completeConnection,
  disconnect,
  initiateConnection,
  parseStateUserId,
  scanInbox,
} from '../integrations/scanReceipts';
import { logger } from '../observability/logger';
import { emailIntegrationEnabled, corsOrigin } from '../config/env';

const router = Router();

function publicStatus(integ: UserEmailIntegration | null) {
  if (!integ) return { connected: false };
  return {
    connected: true,
    provider: integ.provider,
    accountEmail: integ.accountEmail,
    status: integ.status,
    statusReason: integ.statusReason,
    lastScanAt: integ.lastScanAt?.toISOString() ?? null,
    scopes: integ.scopes,
    createdAt: integ.createdAt?.toISOString() ?? null,
  };
}

router.get('/status', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const integ = await UserEmailIntegration.findOne({
      where: { userId: user.id, provider: 'google' },
    });
    res.json({
      ...publicStatus(integ),
      featureEnabled: emailIntegrationEnabled,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/auth/google', async (req, res, next) => {
  try {
    if (!emailIntegrationEnabled) {
      res.status(503).json({
        error:
          'Email integration is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and EMAIL_INTEGRATION_ENCRYPTION_KEY.',
      });
      return;
    }
    const { user } = currentAuth(req);
    const { authUrl } = initiateConnection(user.id);
    res.redirect(authUrl);
  } catch (e) {
    next(e);
  }
});

router.get('/callback/google', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';

    if (errorParam) {
      logger.warn('gmail_oauth_consent_denied', { error: errorParam });
      res.redirect(`${corsOrigin}/settings?gmail=denied`);
      return;
    }
    if (!code || !state) {
      res.status(400).send('Missing code or state');
      return;
    }
    const stateUserId = parseStateUserId(state);
    const { user } = currentAuth(req);
    if (stateUserId !== user.id) {
      logger.warn('gmail_oauth_state_mismatch', { stateUserId, sessionUserId: user.id });
      res.status(400).send('OAuth state mismatch — restart the flow from Settings');
      return;
    }

    const integ = await completeConnection({ userId: user.id, code });
    logger.info('gmail_connected', {
      userId: user.id,
      integrationId: integ.id,
      accountEmail: integ.accountEmail,
    });
    res.redirect(`${corsOrigin}/settings?gmail=connected`);
  } catch (e) {
    next(e);
  }
});

router.post('/disconnect/google', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    await disconnect(user.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/scan/google', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxMessages =
      typeof body.maxMessages === 'number' && body.maxMessages > 0
        ? Math.min(200, Math.floor(body.maxMessages))
        : 50;
    const sinceDateOverride = (() => {
      if (typeof body.sinceDays === 'number' && body.sinceDays > 0) {
        return new Date(Date.now() - Math.min(365, body.sinceDays) * 86_400_000);
      }
      return undefined;
    })();
    const result = await scanInbox({
      userId: user.id,
      householdId: household.id,
      maxMessages,
      sinceDateOverride,
    });
    logger.info('gmail_scan_completed', {
      userId: user.id,
      ...result,
      messages: undefined, // don't log every message body in the structured log
      messageCount: result.messages.length,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
