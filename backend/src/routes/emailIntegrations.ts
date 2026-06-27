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
import { ProcessedEmailMessage, ReceiptSenderAllowlist, UserEmailIntegration } from '../models';
import {
  DEFAULT_RECEIPT_SENDERS,
  completeConnection,
  disconnect,
  initiateConnection,
  parseStateUserId,
  scanInbox,
} from '../integrations/scanReceipts';
import { discoverReceiptSources } from '../integrations/discoverReceiptSources';
import {
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from '../integrations/receiptSenderSuggestions';
import { logger } from '../observability/logger';
import { emailIntegrationEnabled, corsOrigin } from '../config/env';
import { emailScanLimiter } from './emailRateLimit';

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

/**
 * GET /api/email/history?limit=50
 * Persistent scan log: every message the Gmail scan has processed for this
 * household, newest first. The durable counterpart to GmailSection's
 * in-memory live feed.
 */
router.get('/history', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await ProcessedEmailMessage.findAll({
      where: { householdId: household.id },
      order: [
        ['scannedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });
    res.json(
      rows.map((r) => ({
        messageId: r.messageId,
        subject: r.subject,
        fromAddr: r.fromAddr,
        status: r.status,
        parser: r.parser,
        externalOrderId: r.externalOrderId,
        errorMessage: r.errorMessage,
        scannedAt: r.scannedAt?.toISOString() ?? null,
      })),
    );
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
      logger.warn({ error: errorParam }, 'gmail_oauth_consent_denied');
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
      logger.warn({ stateUserId, sessionUserId: user.id }, 'gmail_oauth_state_mismatch');
      res.status(400).send('OAuth state mismatch — restart the flow from Settings');
      return;
    }

    const integ = await completeConnection({ userId: user.id, code });
    logger.info({
      userId: user.id,
      integrationId: integ.id,
      accountEmail: integ.accountEmail,
    }, 'gmail_connected');
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

router.post('/scan/google', emailScanLimiter, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Bumped cap from 200 to 5000 now that we paginate Gmail listMessageIds.
    const maxMessages =
      typeof body.maxMessages === 'number' && body.maxMessages > 0
        ? Math.min(5000, Math.floor(body.maxMessages))
        : 200;
    const sinceDateOverride = (() => {
      if (typeof body.sinceDays === 'number' && body.sinceDays > 0) {
        return new Date(Date.now() - Math.min(3650, body.sinceDays) * 86_400_000);
      }
      return undefined;
    })();

    const accept = String(req.headers['accept'] ?? '').toLowerCase();
    const wantsStream =
      accept.includes('application/x-ndjson') ||
      accept.includes('application/ndjson') ||
      req.query.stream === '1';

    if (!wantsStream) {
      const result = await scanInbox({
        userId: user.id,
        householdId: household.id,
        maxMessages,
        sinceDateOverride,
      });
      logger.info({
        userId: user.id,
        ...result,
        messages: undefined,
        messageCount: result.messages.length,
      }, 'gmail_scan_completed');
      res.json(result);
      return;
    }

    // NDJSON streaming path: emit one event per Gmail-list page, per
    // processed message, and a final summary event.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Financial-PII stream: forbid caching, keep no-transform (issue #853).
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    function emit(obj: unknown) {
      res.write(`${JSON.stringify(obj)}\n`);
    }
    emit({ kind: 'started', maxMessages, sinceDays: body.sinceDays ?? null });

    try {
      const result = await scanInbox(
        {
          userId: user.id,
          householdId: household.id,
          maxMessages,
          sinceDateOverride,
        },
        {
          onPhase: (e) => emit({ kind: 'phase', ...e }),
          onMessage: (m) => emit({ kind: 'message', ...m }),
        },
      );
      logger.info({
        userId: user.id,
        ...result,
        messages: undefined,
        messageCount: result.messages.length,
      }, 'gmail_scan_completed');
      emit({
        kind: 'summary',
        ...result,
        messages: undefined,
        messageCount: result.messages.length,
      });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ userId: user.id, message }, 'gmail_scan_failed');
      emit({ kind: 'error', message });
      res.end();
    }
  } catch (e) {
    next(e);
  }
});

router.post('/discover/google', emailScanLimiter, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxMessages =
      typeof body.maxMessages === 'number' && body.maxMessages > 0
        ? Math.min(2000, Math.floor(body.maxMessages))
        : 300;
    const sinceDateOverride =
      typeof body.sinceDays === 'number' && body.sinceDays > 0
        ? new Date(Date.now() - Math.min(3650, body.sinceDays) * 86_400_000)
        : undefined;

    const accept = String(req.headers['accept'] ?? '').toLowerCase();
    const wantsStream =
      accept.includes('application/x-ndjson') ||
      accept.includes('application/ndjson') ||
      req.query.stream === '1';

    if (!wantsStream) {
      const result = await discoverReceiptSources({
        userId: user.id, householdId: household.id, maxMessages, sinceDateOverride,
      });
      logger.info({ userId: user.id, ...result, messages: undefined, messageCount: result.messages.length }, 'gmail_discovery_completed');
      res.json(result);
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Financial-PII stream: forbid caching, keep no-transform (issue #853).
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    emit({ kind: 'started', maxMessages, sinceDays: body.sinceDays ?? null });
    try {
      const result = await discoverReceiptSources(
        { userId: user.id, householdId: household.id, maxMessages, sinceDateOverride },
        { onPhase: (e) => emit({ kind: 'phase', ...e }), onMessage: (m) => emit({ kind: 'message', ...m }) },
      );
      logger.info({ userId: user.id, ...result, messages: undefined, messageCount: result.messages.length }, 'gmail_discovery_completed');
      emit({ kind: 'summary', ...result, messages: undefined, messageCount: result.messages.length });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ userId: user.id, message }, 'gmail_discovery_failed');
      emit({ kind: 'error', message });
      res.end();
    }
  } catch (e) {
    next(e);
  }
});

router.get('/suggestions', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    res.json(await listSenderSuggestions(household.id));
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/approve', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const ok = await promoteSuggestion({ householdId: household.id, id });
    if (!ok) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/dismiss', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const ok = await dismissSuggestion({ householdId: household.id, id });
    if (!ok) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * GET  /api/email/allowlist        — defaults + this household's custom senders
 * POST /api/email/allowlist        — add a sender
 * PATCH /api/email/allowlist/:id   — toggle enabled / edit label
 * DELETE /api/email/allowlist/:id  — remove a custom sender (defaults aren't deletable)
 */
router.get('/allowlist', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const custom = await ReceiptSenderAllowlist.findAll({
      where: { householdId: household.id },
      order: [['email_address', 'ASC']],
    });
    res.json({
      defaults: DEFAULT_RECEIPT_SENDERS,
      custom: custom.map((r) => ({
        id: r.id,
        emailAddress: r.emailAddress,
        label: r.label,
        vendorHint: r.vendorHint,
        enabled: r.enabled,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/allowlist', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const emailAddress = String(body.emailAddress ?? '').trim().toLowerCase();
    if (!emailAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      res.status(400).json({ error: 'emailAddress must be a valid email' });
      return;
    }
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 128) : null;
    const vendorHint = typeof body.vendorHint === 'string' && body.vendorHint.trim() ? body.vendorHint.trim().slice(0, 32) : null;
    const [row, created] = await ReceiptSenderAllowlist.findOrCreate({
      where: { householdId: household.id, emailAddress },
      defaults: {
        householdId: household.id,
        emailAddress,
        label,
        vendorHint,
        enabled: true,
      },
    });
    if (!created) {
      // Re-enable + update label if the user is re-adding an existing row.
      row.set({ enabled: true });
      if (label) row.set({ label });
      if (vendorHint) row.set({ vendorHint });
      await row.save();
    }
    res.status(created ? 201 : 200).json({
      id: row.id,
      emailAddress: row.emailAddress,
      label: row.label,
      vendorHint: row.vendorHint,
      enabled: row.enabled,
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/allowlist/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ReceiptSenderAllowlist.findOne({
      where: { id, householdId: household.id },
    });
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled === 'boolean') row.set({ enabled: body.enabled });
    if (typeof body.label === 'string') row.set({ label: body.label.trim() || null });
    if (typeof body.vendorHint === 'string') row.set({ vendorHint: body.vendorHint.trim() || null });
    await row.save();
    res.json({
      id: row.id,
      emailAddress: row.emailAddress,
      label: row.label,
      vendorHint: row.vendorHint,
      enabled: row.enabled,
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/allowlist/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ReceiptSenderAllowlist.findOne({
      where: { id, householdId: household.id },
    });
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await row.destroy();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
