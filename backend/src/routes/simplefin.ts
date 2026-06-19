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
  SimplefinConnectResponse,
  SimplefinDisconnectResponse,
  SimplefinStatusResponse,
} from '@cashflow/shared';
import { currentAuth } from '../auth/middleware';
import { logger } from '../observability/logger';
import { SimplefinError } from '../simplefin/client';
import { connect, disconnect, status } from '../simplefin/service';

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
