/**
 * SimpleFIN Bridge connection routes (issue #790).
 *
 *   POST /api/simplefin/connect     — exchange a setup token, store access URL
 *   GET  /api/simplefin/status      — masked connection state
 *   POST /api/simplefin/disconnect  — delete the connection (idempotent)
 *
 * Mounted in the gated (post-requireAuth) section of routeRegistry.ts, so all
 * three require a session; an unauthenticated request 401s before reaching here.
 */
import { Router } from 'express';
import type {
  SimplefinAccountsResponse,
  SimplefinConnectResponse,
  SimplefinDisconnectResponse,
  SimplefinLinkRequest,
  SimplefinLinkResponse,
  SimplefinStatusResponse,
  SimplefinSyncResponse,
} from '@cashflow/shared';
import { currentAuth } from '../auth/middleware';
import { logger } from '../observability/logger';
import { SimplefinError } from '../simplefin/client';
import { connect, disconnect, status } from '../simplefin/service';
import {
  SimplefinLinkError,
  linkAccount,
  listDiscoveredAccounts,
  unlinkAccount,
} from '../simplefin/links';
import { syncSimplefin } from '../simplefin/sync';
import { isTickRunning } from '../jobs/runner';
import { UserSimplefinIntegration } from '../models';

const GENERIC_CONNECT_ERROR =
  "We couldn't connect your bank. Check that you pasted a fresh setup token and try again.";
const INVALID_TOKEN_MESSAGE =
  "That setup token isn't valid. Paste a fresh token from SimpleFIN Bridge.";

const router = Router();

router.post('/connect', async (req, res) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const setupToken =
      typeof body.setupToken === 'string' ? body.setupToken.trim() : '';
    if (!setupToken) {
      res.status(400).json({
        error: 'invalid_setup_token',
        message: INVALID_TOKEN_MESSAGE,
      });
      return;
    }

    const result = await connect({
      userId: user.id,
      householdId: household?.id ?? null,
      setupToken,
    });
    const payload: SimplefinConnectResponse = {
      status: result.status,
      accountsFound: result.accountsFound,
      accountsLinked: result.accountsLinked,
      unlinkedAccounts: result.unlinkedAccounts,
    };
    logger.info(
      {
        userId: user.id,
        accountsFound: result.accountsFound,
        accountsLinked: result.accountsLinked,
      },
      'simplefin_connected',
    );
    res.json(payload);
  } catch (e) {
    if (e instanceof SimplefinError) {
      if (e.code === 'invalid_setup_token') {
        logger.warn({ message: e.message }, 'simplefin_invalid_setup_token');
        res.status(400).json({
          error: 'invalid_setup_token',
          message: INVALID_TOKEN_MESSAGE,
        });
        return;
      }
      // claim_exchange_failed / discovery_failed → claim exchange failure family.
      logger.warn({ code: e.code, message: e.message }, 'simplefin_claim_exchange_failed');
      res.status(502).json({
        error: 'claim_exchange_failed',
        message: GENERIC_CONNECT_ERROR,
      });
      return;
    }
    // Encryption/persist failure (e.g. missing EMAIL_INTEGRATION_ENCRYPTION_KEY).
    logger.error(
      { message: e instanceof Error ? e.message : String(e) },
      'simplefin_storage_failed',
    );
    res.status(500).json({
      error: 'storage_failed',
      message: GENERIC_CONNECT_ERROR,
    });
  }
});

router.get('/status', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const result = await status(user.id);
    const payload: SimplefinStatusResponse = {
      connected: result.connected,
      status: result.status,
      statusReason: result.statusReason,
      lastSyncedAt: result.lastSyncedAt,
      host: result.host,
    };
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

router.post('/sync', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const integrationId =
      typeof body.integrationId === 'number' ? body.integrationId : undefined;

    // 404 if a specific integration is named but not owned by this user.
    if (integrationId != null) {
      const owned = await UserSimplefinIntegration.findOne({
        where: { id: integrationId, userId: user.id },
      });
      if (!owned || owned.status === 'disconnected') {
        res.status(404).json({
          error: 'not_found',
          message: 'No connected SimpleFIN integration with that id.',
        });
        return;
      }
    }

    // 409 if the nightly job is already running — avoid concurrent commits.
    if (isTickRunning('simplefin_sync')) {
      res.status(409).json({
        error: 'sync_in_progress',
        message: 'A sync is already running. Try again shortly.',
      });
      return;
    }

    const { runs } = await syncSimplefin({ userId: user.id, integrationId });
    if (runs.some((r) => r.status === 'error')) {
      logger.warn(
        { userId: user.id, integrationId, runs: runs.length },
        'simplefin_manual_sync_partial_error',
      );
    } else {
      logger.info(
        { userId: user.id, integrationId, runs: runs.length },
        'simplefin_manual_sync_ok',
      );
    }
    const payload: SimplefinSyncResponse = { runs };
    res.json(payload);
  } catch (e) {
    if (e instanceof SimplefinError && e.unauthorized) {
      res.status(502).json({
        error: 'sync_failed',
        message:
          "Couldn't sync — your bank connection may need to be reconnected.",
      });
      return;
    }
    if (e instanceof SimplefinError) {
      res.status(502).json({ error: 'sync_failed', message: e.message });
      return;
    }
    next(e);
  }
});

/** Map a SimplefinLinkError code to an HTTP status + error body. */
function sendLinkError(res: import('express').Response, e: SimplefinLinkError): void {
  switch (e.code) {
    case 'not_connected':
      res.status(404).json({ error: 'not_connected', message: e.message });
      return;
    case 'discovery_failed':
      res.status(502).json({ error: 'discovery_failed', message: e.message });
      return;
    case 'not_found':
      res.status(404).json({ error: 'not_found', message: e.message });
      return;
    case 'account_not_found':
      res.status(404).json({ error: 'account_not_found', message: e.message });
      return;
    case 'account_not_in_household':
      res.status(400).json({ error: 'account_not_in_household', message: e.message });
      return;
    case 'invalid_request':
      res.status(400).json({ error: 'invalid_request', message: e.message });
      return;
    case 'already_linked':
      res
        .status(409)
        .json({ error: 'already_linked', ownedByCurrentUser: e.ownedByCurrentUser });
      return;
    default:
      res.status(500).json({ error: 'storage_failed', message: e.message });
  }
}

// SimpleFIN explicit account mapping (issue #813).
router.get('/accounts', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const accounts = await listDiscoveredAccounts(user.id, household?.id ?? null);
    const payload: SimplefinAccountsResponse = { accounts };
    res.json(payload);
  } catch (e) {
    if (e instanceof SimplefinLinkError) {
      sendLinkError(res, e);
      return;
    }
    next(e);
  }
});

router.post('/accounts/:simplefinId/link', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as SimplefinLinkRequest;
    const result = await linkAccount({
      userId: user.id,
      householdId: household?.id ?? null,
      simplefinId: req.params.simplefinId,
      accountId: typeof body.accountId === 'number' ? body.accountId : undefined,
      create: body.create,
    });
    const payload: SimplefinLinkResponse = {
      simplefinId: result.simplefinId,
      linkedAccountId: result.linkedAccountId,
    };
    logger.info(
      { userId: user.id, simplefinId: result.simplefinId, accountId: result.linkedAccountId },
      'simplefin_account_linked',
    );
    res.json(payload);
  } catch (e) {
    if (e instanceof SimplefinLinkError) {
      sendLinkError(res, e);
      return;
    }
    next(e);
  }
});

router.delete('/accounts/:simplefinId/link', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const result = await unlinkAccount(user.id, req.params.simplefinId);
    const payload: SimplefinLinkResponse = {
      simplefinId: result.simplefinId,
      linkedAccountId: result.linkedAccountId,
    };
    res.json(payload);
  } catch (e) {
    if (e instanceof SimplefinLinkError) {
      sendLinkError(res, e);
      return;
    }
    next(e);
  }
});

router.post('/disconnect', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    await disconnect(user.id);
    const payload: SimplefinDisconnectResponse = { status: 'disconnected' };
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

export default router;
