/**
 * SimpleFIN recurring transaction sync (issue #791).
 *
 * For each connected SimpleFIN integration this fetches new transactions since
 * `lastSyncedAt` (or a 90-day backfill on first sync), maps them to
 * `NormalizedCashTransaction[]`, and commits them through the existing
 * `commitStatementImport` path with `profileId: 'simplefin'`. Dedup (including
 * cross-source CSV matching and pending-promotion) is reused VERBATIM via
 * `findExistingForDedup` inside the commit path — this module never touches
 * `dedupExisting.ts`.
 *
 * The recurring driver is the `simplefin_sync` cron job
 * (`jobs/definitions/simplefinSync.ts`); the manual "Sync now" route
 * (`POST /api/simplefin/sync`) calls the same engine synchronously.
 */
import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import {
  Account,
  HouseholdMember,
  SimplefinAccountLink,
  UserSimplefinIntegration,
} from '../models';
import { decryptSecret } from '../util/symmetricEncryption';
import { logger } from '../observability/logger';
import { commitStatementImport } from '../import/commitStatementImport';
import { normalizeMerchant } from '../import/normalizeMerchant';
import { rowFingerprint } from '../import/fingerprint';
import type {
  NormalizedCashTransaction,
  StatementPreview,
} from '../import/statementTypes';
import {
  SimplefinError,
  fetchTransactions,
  type SimplefinAccountWithTransactions,
  type SimplefinTransaction,
} from './client';

/** First-sync backfill window in days when `lastSyncedAt` is null. */
export const BACKFILL_WINDOW_DAYS = 90;

/** Per-account result of a single integration sync. */
export interface SimplefinSyncAccountRun {
  integrationId: number;
  accountId: number;
  inserted: number;
  skippedDuplicate: number;
  status: 'connected' | 'error';
}

/**
 * Resolve a SimpleFIN account (by its stable id) to the Cashflow Account it is
 * EXPLICITLY linked to, via `SimplefinAccountLink` scoped to the integration
 * (issue #813). There is no name-based fallback: an unlinked discovered account
 * resolves to null and is skipped (logged), never guessed. This structurally
 * prevents cross-member writes (a link can only point at an account the linker
 * chose) and shared-account double-import (UNIQUE(account_id) lets exactly one
 * integration own a given account).
 */
export function resolveAccountId(
  remote: { id: string },
  linksBySimplefinId: Map<string, number>,
): number | null {
  return linksBySimplefinId.get(remote.id) ?? null;
}

/** Convert SimpleFIN posted epoch seconds to a YYYY-MM-DD (UTC) date. */
export function postedToDate(posted: number): string {
  return new Date(posted * 1000).toISOString().slice(0, 10);
}

/** Map one SimpleFIN transaction to a NormalizedCashTransaction. */
export function mapSimplefinTransaction(
  tx: SimplefinTransaction,
  accountId: number,
  currency: string,
): NormalizedCashTransaction {
  const date = postedToDate(tx.posted);
  const amount = Number(tx.amount);
  const merchantRaw = (tx.payee && tx.payee.trim()) || tx.description || '';
  return {
    date,
    merchantRaw,
    merchantClean: normalizeMerchant(merchantRaw),
    amount,
    currency,
    sourceReference: tx.id,
    sourceRowFingerprint: rowFingerprint({
      accountId,
      date,
      amount,
      currency,
      merchantRaw,
      sourceReference: tx.id,
    }),
  };
}

/** Compute the `start-date` epoch (unix seconds) for an integration. */
export function startDateEpoch(lastSyncedAt: Date | null, now: Date): number {
  const ms = lastSyncedAt
    ? lastSyncedAt.getTime()
    : now.getTime() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(ms / 1000);
}

/** Build a minimal StatementPreview for one account's SimpleFIN transactions. */
function buildPreview(
  accountId: number,
  householdId: number | null,
  transactions: NormalizedCashTransaction[],
  contentHash: string,
  importBatch: string,
): StatementPreview {
  return {
    previewToken: importBatch,
    fileName: `simplefin-${importBatch}`,
    contentHash,
    accountId,
    householdId,
    importBatch,
    usedParser: 'ofx',
    usedProfileId: 'simplefin',
    profileInferred: false,
    transactions,
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

/**
 * Sync a single integration. Resolves its household + accounts, fetches
 * transactions since the last sync, and commits each account's transactions.
 * On success advances `lastSyncedAt` to `now` and sets `status='connected'`.
 * On an unauthorized (401/403) failure sets `status='error'` WITHOUT advancing
 * `lastSyncedAt`, and rethrows so the caller reports the run as failed.
 */
export async function syncIntegration(
  integration: UserSimplefinIntegration,
  now: Date = new Date(),
): Promise<SimplefinSyncAccountRun[]> {
  const membership = await HouseholdMember.findOne({
    where: { userId: integration.userId },
  });
  const householdId = membership?.householdId ?? null;

  let accessUrl: string;
  try {
    accessUrl = decryptSecret(integration.accessUrlEncrypted);
  } catch (e) {
    logger.error(
      { integrationId: integration.id, message: e instanceof Error ? e.message : String(e) },
      'simplefin_sync_decrypt_failed',
    );
    throw new SimplefinError('sync_failed', 'Could not decrypt access URL');
  }

  let remoteAccounts: SimplefinAccountWithTransactions[];
  try {
    remoteAccounts = await fetchTransactions(
      accessUrl,
      startDateEpoch(integration.lastSyncedAt, now),
    );
  } catch (e) {
    if (e instanceof SimplefinError && e.unauthorized) {
      integration.set({ status: 'error', statusReason: 'token_revoked' });
      await integration.save();
    }
    throw e;
  }

  // Explicit links for THIS integration are the single source of truth (#813).
  const links = await SimplefinAccountLink.findAll({
    where: { integrationId: integration.id },
    attributes: ['simplefinAccountId', 'accountId'],
  });
  const linksBySimplefinId = new Map(
    links.map((l) => [l.simplefinAccountId, l.accountId]),
  );
  const linkedAccountIds = [...linksBySimplefinId.values()];
  const accounts =
    linkedAccountIds.length === 0
      ? []
      : await Account.findAll({
          where: { id: { [Op.in]: linkedAccountIds }, mergedIntoId: { [Op.is]: null } },
          attributes: ['id', 'name', 'defaultCurrency', 'householdId'],
        });

  const runs: SimplefinSyncAccountRun[] = [];
  for (const remote of remoteAccounts) {
    const accountId = resolveAccountId(remote, linksBySimplefinId);
    if (accountId == null) {
      logger.warn(
        { integrationId: integration.id, simplefinAccountId: remote.id, name: remote.name },
        'simplefin_sync_account_unresolved',
      );
      continue;
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      // Linked account was merged/deleted out from under the link; skip safely.
      logger.warn(
        { integrationId: integration.id, simplefinAccountId: remote.id, accountId },
        'simplefin_sync_linked_account_missing',
      );
      continue;
    }
    const currency = (remote.currency || account.defaultCurrency || 'CAD').toUpperCase();
    const normalized = remote.transactions.map((tx) =>
      mapSimplefinTransaction(tx, accountId, currency),
    );
    // Unique per-run content hash so commitStatementImport's prior-import
    // short-circuit never falsely no-ops a sync; the per-row dedup inside the
    // commit path is what keeps re-runs idempotent.
    const importBatch = `simplefin-${integration.id}-${accountId}-${now.getTime()}`;
    const contentHash = createHash('sha256')
      .update(importBatch)
      .digest('hex');
    const preview = buildPreview(
      accountId,
      account.householdId ?? householdId,
      normalized,
      contentHash,
      importBatch,
    );
    const result = await commitStatementImport(
      preview,
      integration.userId,
      householdId,
    );
    runs.push({
      integrationId: integration.id,
      accountId,
      inserted: result.insertedTransactions,
      skippedDuplicate: result.skippedDuplicates,
      status: 'connected',
    });
  }

  integration.set({ status: 'connected', statusReason: null, lastSyncedAt: now });
  await integration.save();
  return runs;
}

/**
 * Sync connected SimpleFIN integrations. Scope with `userId` (one user's
 * integration) and/or `integrationId` (a specific row). With neither, syncs
 * every connected integration (the cron path). Per-integration errors are
 * isolated: a failure on one integration is recorded as an `error` run and the
 * next integration proceeds.
 */
export async function syncSimplefin(
  opts: { userId?: number; integrationId?: number; now?: Date } = {},
): Promise<{ runs: SimplefinSyncAccountRun[]; integrationsProcessed: number }> {
  const now = opts.now ?? new Date();
  const where: Record<string, unknown> = { status: { [Op.ne]: 'disconnected' } };
  if (opts.userId != null) where.userId = opts.userId;
  if (opts.integrationId != null) where.id = opts.integrationId;

  const integrations = await UserSimplefinIntegration.findAll({ where });
  const runs: SimplefinSyncAccountRun[] = [];
  for (const integration of integrations) {
    try {
      runs.push(...(await syncIntegration(integration, now)));
    } catch (e) {
      logger.warn(
        { integrationId: integration.id, message: e instanceof Error ? e.message : String(e) },
        'simplefin_sync_integration_failed',
      );
      runs.push({
        integrationId: integration.id,
        accountId: 0,
        inserted: 0,
        skippedDuplicate: 0,
        status: 'error',
      });
    }
  }
  return { runs, integrationsProcessed: integrations.length };
}
