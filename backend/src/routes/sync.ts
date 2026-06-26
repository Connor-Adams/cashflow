/**
 * /api/sync — local-first encrypted backup & restore endpoints (Cashflow #239).
 *
 *   POST /api/sync/backup         create a passphrase-encrypted bundle
 *   POST /api/sync/restore/preview decrypt + report what WOULD restore
 *   POST /api/sync/restore         decrypt + apply (merge or replace)
 *   GET  /api/sync/history         list past backup/restore events
 *
 * Endpoints are scoped to the caller's active household. Rate-limited
 * via aiSuggestLimiter because each call does CPU-heavy PBKDF2 work
 * plus a full per-household table scan.
 *
 * The wire format is JSON for portability: the bundle is base64-encoded
 * inside a `bundle` field. The browser decodes/encodes base64 natively
 * and the user downloads the JSON file directly.
 */
import { Router, type Request } from 'express';
import { currentAuth } from '../auth/middleware';
import { isHouseholdOwner } from '../auth/scope';
import { sequelize, SyncBackup } from '../models';
import {
  BUNDLE_SCHEMA_VERSION,
  bundleStats,
  decryptBundle,
  encryptBundle,
} from '../sync/bundleFormat';
import { buildBundle } from '../sync/buildBundle';
import { restoreBundle, type RestoreMode } from '../sync/restoreBundle';
import { aiSuggestLimiter } from './aiRateLimit';

const router = Router();

const BUNDLE_ENVELOPE_VERSION = 1;
const MIN_PASSPHRASE_LEN = 8;
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // 25 MB cap to prevent OOM

function validatePassphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSPHRASE_LEN) {
    throw badRequest(`passphrase must be a string of at least ${MIN_PASSPHRASE_LEN} characters`);
  }
  return value;
}

function badRequest(message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = 400;
  return e;
}

/**
 * Backup and restore operate on the WHOLE household: backup exfiltrates every
 * member's data, and restore (mode=replace) wipes it. These are owner-gated by
 * the same posture household member removal already enforces — a non-owner
 * member must not be able to export or destroy the household (#836).
 *
 * Gate via the shared {@link isHouseholdOwner}, which also admits a superadmin
 * (consistent with feedback review and the rest of the owner-gated surface). A
 * superadmin already reads every household via the scope helpers, and sync is
 * bound to the caller's *active* household, so this widens nothing they cannot
 * already reach — it just folds the gate onto the canonical helper. (#836's AC
 * said strictly role==='owner'; #816's superadmin carve-out supersedes it.)
 *
 * Throwing a 403 here keeps the gate at the very top of each handler, before
 * any passphrase validation, decryption, or destructive table scan runs.
 */
function requireOwner(req: Request): void {
  if (!isHouseholdOwner(req)) {
    const e = new Error('Only the household owner can back up or restore data') as Error & {
      status: number;
    };
    e.status = 403;
    throw e;
  }
}

/**
 * POST /api/sync/backup { passphrase }
 *
 * Builds a bundle for the active household, encrypts it with the
 * user-supplied passphrase, records a row in sync_backups, and
 * returns the base64 bundle + metadata.
 */
router.post('/backup', aiSuggestLimiter, async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    requireOwner(req);
    const passphrase = validatePassphrase(req.body?.passphrase);

    const payload = await buildBundle(sequelize, {
      householdId: auth.household.id,
      origin: `cashflow/${process.env.npm_package_version ?? 'dev'}`,
    });
    const bundle = encryptBundle(passphrase, payload);
    const stats = bundleStats(bundle, payload);

    if (stats.bytes > MAX_BUNDLE_BYTES) {
      throw badRequest(`bundle size ${stats.bytes} bytes exceeds limit ${MAX_BUNDLE_BYTES}`);
    }

    await SyncBackup.create({
      householdId: auth.household.id,
      userId: auth.user.id,
      kind: 'backup',
      bundleVersion: BUNDLE_ENVELOPE_VERSION,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleBytes: stats.bytes,
      tableCounts: stats.tableCounts,
    });

    res.json({
      bundle,
      bundleVersion: BUNDLE_ENVELOPE_VERSION,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: payload.createdAt,
      origin: payload.origin,
      bundleBytes: stats.bytes,
      rowCount: stats.rowCount,
      tableCounts: stats.tableCounts,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sync/restore/preview { passphrase, bundle }
 *
 * Decrypts the bundle and returns row counts + source metadata
 * WITHOUT writing anything. UI uses this to confirm the user picked
 * the right file before they commit.
 */
router.post('/restore/preview', aiSuggestLimiter, async (req, res, next) => {
  try {
    requireOwner(req);
    const passphrase = validatePassphrase(req.body?.passphrase);
    const bundle = req.body?.bundle;
    if (typeof bundle !== 'string' || bundle.length === 0) {
      throw badRequest('bundle is required (base64 string)');
    }
    if (bundle.length > MAX_BUNDLE_BYTES) {
      throw badRequest('bundle exceeds maximum allowed size');
    }

    let payload;
    try {
      payload = decryptBundle(passphrase, bundle);
    } catch (err) {
      const message =
        err instanceof Error && /version|schema|too short|empty/.test(err.message)
          ? err.message
          : 'Unable to decrypt bundle (bad passphrase or tampered file)';
      throw badRequest(message);
    }

    const stats = bundleStats(bundle, payload);
    res.json({
      sourceHouseholdId: payload.sourceHouseholdId,
      createdAt: payload.createdAt,
      origin: payload.origin,
      schemaVersion: payload.schemaVersion,
      bundleBytes: stats.bytes,
      rowCount: stats.rowCount,
      tableCounts: stats.tableCounts,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sync/restore { passphrase, bundle, mode }
 *
 * Decrypts the bundle, applies it to the active household. `mode` is
 * 'merge' (default — refuses if existing rows present) or 'replace'
 * (wipes the V1 tables for this household first). Records a row in
 * sync_backups for audit.
 */
router.post('/restore', aiSuggestLimiter, async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    requireOwner(req);
    const passphrase = validatePassphrase(req.body?.passphrase);
    const bundle = req.body?.bundle;
    if (typeof bundle !== 'string' || bundle.length === 0) {
      throw badRequest('bundle is required (base64 string)');
    }
    if (bundle.length > MAX_BUNDLE_BYTES) {
      throw badRequest('bundle exceeds maximum allowed size');
    }
    const mode: RestoreMode = req.body?.mode === 'replace' ? 'replace' : 'merge';

    let payload;
    try {
      payload = decryptBundle(passphrase, bundle);
    } catch (err) {
      const message =
        err instanceof Error && /version|schema|too short|empty/.test(err.message)
          ? err.message
          : 'Unable to decrypt bundle (bad passphrase or tampered file)';
      throw badRequest(message);
    }

    let result;
    try {
      result = await restoreBundle(sequelize, payload, {
        householdId: auth.household.id,
        mode,
        dryRun: false,
      });
    } catch (err) {
      // restoreBundle's "merge with existing rows" branch is user-facing
      // — surface as 400 so the UI can prompt for replace mode.
      const message = err instanceof Error ? err.message : 'restore failed';
      if (/Refusing to restore/i.test(message)) {
        throw badRequest(message);
      }
      throw err;
    }

    const stats = bundleStats(bundle, payload);
    await SyncBackup.create({
      householdId: auth.household.id,
      userId: auth.user.id,
      kind: 'restore',
      bundleVersion: BUNDLE_ENVELOPE_VERSION,
      schemaVersion: payload.schemaVersion,
      bundleBytes: stats.bytes,
      tableCounts: result.inserted,
    });

    res.json({
      mode,
      inserted: result.inserted,
      skipped: result.skipped,
      sourceHouseholdId: payload.sourceHouseholdId,
      createdAt: payload.createdAt,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/sync/history
 *
 * Lists the past backup/restore events for the active household.
 */
router.get('/history', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
      200,
    );

    const rows = await SyncBackup.findAll({
      where: { householdId: auth.household.id },
      order: [['createdAt', 'DESC']],
      limit,
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        bundleVersion: r.bundleVersion,
        schemaVersion: r.schemaVersion,
        bundleBytes: r.bundleBytes,
        tableCounts: r.tableCounts,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
