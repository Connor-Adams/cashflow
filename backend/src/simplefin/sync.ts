/**
 * SimpleFIN recurring transaction sync (issue #791).
 *
 * For each connected SimpleFIN integration this fetches transactions posted
 * since `lastSyncedAt` minus a lookback (or a 90-day backfill on first sync),
 * maps them to
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
  Transaction,
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * First-sync backfill window in days when `lastSyncedAt` is null. Also the
 * furthest back any fetch reaches.
 */
export const BACKFILL_WINDOW_DAYS = 90;

/**
 * How far before `lastSyncedAt` each fetch starts. SimpleFIN filters on
 * `posted` (12:00 UTC on the transaction's date) but only learns of a charge
 * when it next refreshes the institution, a day or more later. A window that
 * opens at the previous run therefore excludes every charge that surfaced
 * since. The overlap costs nothing: re-fetched feed rows dedup on their
 * SimpleFIN transaction id.
 */
export const SYNC_LOOKBACK_DAYS = 14;

/**
 * A `balance-date` older than this means SimpleFIN has stopped refreshing the
 * account from its institution, so no new transactions can arrive.
 */
export const STALE_BALANCE_DAYS = 3;

/** Per-account result of a single integration sync. */
export interface SimplefinSyncAccountRun {
  integrationId: number;
  accountId: number;
  inserted: number;
  skippedDuplicate: number;
  /** Feed rows left out because a statement/CSV import already covers their date. */
  skippedCovered: number;
  /** 'error' when SimpleFIN has stopped refreshing this account. */
  status: 'connected' | 'error';
}

/** Result of syncing one integration. */
export interface SimplefinIntegrationSyncResult {
  runs: SimplefinSyncAccountRun[];
  /** SimpleFIN's own per-institution error messages for this fetch. */
  institutionErrors: string[];
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

/**
 * Why a run that resolved nothing must fail rather than report success.
 *
 * A sync whose links all fail to resolve produces an empty `runs` array, so the
 * job's `errors = runs.filter(r => r.status === 'error').length` is trivially 0.
 * Combined with `accountRuns=0` that is indistinguishable from "no new
 * transactions", which is a perfectly normal quiet day — so nothing alerts.
 *
 * That is exactly how the 20260628000001 migration's placeholder links (account
 * NAME written into `simplefin_account_id`) went unnoticed for three months:
 * status stayed `connected`, `lastSyncedAt` advanced daily, and zero rows were
 * ever imported.
 *
 * Partial resolution is deliberately NOT a failure: one stale link should not
 * hold back the sync window for the accounts that did resolve.
 */
export function resolutionFailureReason(
  linkCount: number,
  resolvedCount: number,
): 'links_unresolved' | null {
  return linkCount > 0 && resolvedCount === 0 ? 'links_unresolved' : null;
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

/**
 * Compute the `start-date` epoch (unix seconds) for an integration:
 * `SYNC_LOOKBACK_DAYS` before `lastSyncedAt`, never further back than the
 * first-sync backfill window.
 */
export function startDateEpoch(lastSyncedAt: Date | null, now: Date): number {
  const backfillMs = now.getTime() - BACKFILL_WINDOW_DAYS * DAY_MS;
  const ms = lastSyncedAt
    ? Math.max(backfillMs, lastSyncedAt.getTime() - SYNC_LOOKBACK_DAYS * DAY_MS)
    : backfillMs;
  return Math.floor(ms / 1000);
}

/** True when SimpleFIN's last refresh of an account is too old to trust. */
export function isBalanceStale(balanceDate: number | null, now: Date): boolean {
  return balanceDate != null && now.getTime() - balanceDate * 1000 > STALE_BALANCE_DAYS * DAY_MS;
}

/**
 * The `statusReason` for a fetch whose institutions need attention, or null
 * when every institution is healthy.
 *
 * SimpleFIN answers 200 when an institution connection breaks: it lists the
 * failure in the payload's `errors` and keeps serving that institution's last
 * good data. The repair happens on the SimpleFIN Bridge side (re-authenticate
 * the institution), not by re-claiming a setup token.
 */
export function institutionAttentionReason(
  institutionErrors: string[],
  staleAccountNames: string[],
): string | null {
  const parts = [...institutionErrors];
  if (staleAccountNames.length > 0) {
    parts.push(
      `not refreshed by SimpleFIN in over ${STALE_BALANCE_DAYS} days: ${staleAccountNames.join(', ')}`,
    );
  }
  return parts.length > 0 ? `institution_attention: ${parts.join(' | ')}` : null;
}

/**
 * Drop feed rows dated before `importedThrough`, the newest posted row a
 * statement/CSV import wrote to the account.
 *
 * The lookback re-fetches days such an import may already hold, and the
 * commit-path dedup cannot pair the two: both rows carry a reference (the
 * SimpleFIN TRN-… id vs the statement's own) and the payee text differs
 * ("Guelph Grotto" vs "GUELPH GROTTO GUELPH"), so the charge would land twice.
 * The floor day itself is kept and left to that dedup, since a statement can
 * close partway through a day.
 */
export function dropCoveredTransactions(
  transactions: NormalizedCashTransaction[],
  importedThrough: string | null,
): { kept: NormalizedCashTransaction[]; covered: number } {
  if (importedThrough == null) return { kept: transactions, covered: 0 };
  const kept = transactions.filter((t) => t.date >= importedThrough);
  return { kept, covered: transactions.length - kept.length };
}

/**
 * Why a finished job run must be recorded as failed, or null when it is clean.
 * A clean run may insert nothing: a quiet day is not an error.
 */
export function syncRunFailureMessage(summary: {
  errors: number;
  institutionErrors: string[];
}): string | null {
  const parts: string[] = [];
  if (summary.errors > 0) parts.push(`${summary.errors} account run(s) in error`);
  if (summary.institutionErrors.length > 0) {
    parts.push(`SimpleFIN reported: ${summary.institutionErrors.join(' | ')}`);
  }
  return parts.length > 0 ? `simplefin_sync degraded: ${parts.join('; ')}` : null;
}

/** Newest posted date a statement/CSV import wrote to the account, if any. */
async function importedThrough(accountId: number): Promise<string | null> {
  const max = await Transaction.max<string | Date | null, Transaction>('date', {
    where: {
      accountId,
      status: 'posted',
      sourceTier: 'authoritative',
      // Hand-entered rows say nothing about what a statement covered.
      importBatch: { [Op.notLike]: 'manual%' },
    },
  });
  if (max == null) return null;
  return max instanceof Date ? max.toISOString().slice(0, 10) : String(max).slice(0, 10);
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
    // The feed reports the AUTHORISED amount. A pending card charge can change
    // value before it settles and some never settle, so a later statement is
    // allowed to correct or remove these rows.
    sourceTier: 'provisional',
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
 * transactions since the last sync (minus the lookback), and commits each
 * account's transactions. On a clean fetch advances `lastSyncedAt` to `now`
 * and sets `status='connected'`. When SimpleFIN reports institution errors or
 * serves stale accounts, commits what did arrive but sets `status='error'`
 * WITHOUT advancing `lastSyncedAt`. On an unauthorized (401/403) failure sets
 * `status='error'` WITHOUT advancing `lastSyncedAt`, and rethrows so the
 * caller reports the run as failed.
 */
export async function syncIntegration(
  integration: UserSimplefinIntegration,
  now: Date = new Date(),
): Promise<SimplefinIntegrationSyncResult> {
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
  let institutionErrors: string[];
  try {
    ({ accounts: remoteAccounts, errors: institutionErrors } = await fetchTransactions(
      accessUrl,
      startDateEpoch(integration.lastSyncedAt, now),
    ));
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
  const staleAccountNames: string[] = [];
  let resolvedCount = 0;
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
    resolvedCount += 1;
    const stale = isBalanceStale(remote.balanceDate, now);
    if (stale) {
      staleAccountNames.push(remote.name);
      logger.warn(
        {
          integrationId: integration.id,
          accountId,
          name: remote.name,
          balanceDate: remote.balanceDate,
        },
        'simplefin_sync_account_stale',
      );
    }
    const currency = (remote.currency || account.defaultCurrency || 'CAD').toUpperCase();
    const { kept: normalized, covered } = dropCoveredTransactions(
      remote.transactions.map((tx) => mapSimplefinTransaction(tx, accountId, currency)),
      await importedThrough(accountId),
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
      skippedCovered: covered,
      status: stale ? 'error' : 'connected',
    });
  }

  const failure = resolutionFailureReason(links.length, resolvedCount);
  if (failure) {
    // Deliberately do NOT advance lastSyncedAt: sliding the window forward past
    // data we never imported would make the gap permanent.
    integration.set({ status: 'error', statusReason: failure });
    await integration.save();
    logger.error(
      {
        integrationId: integration.id,
        links: links.length,
        remoteAccounts: remoteAccounts.length,
      },
      'simplefin_sync_links_unresolved',
    );
    throw new SimplefinError(
      'sync_failed',
      `None of ${links.length} linked accounts matched a SimpleFIN account id. ` +
        'Re-link the accounts so the links store real remote ids.',
    );
  }

  const attention = institutionAttentionReason(institutionErrors, staleAccountNames);
  if (attention) {
    // Rows from healthy institutions were committed above. Hold lastSyncedAt:
    // once the connection is repaired SimpleFIN backfills the outage, and those
    // rows are dated inside it.
    integration.set({ status: 'error', statusReason: attention });
    await integration.save();
    logger.error(
      { integrationId: integration.id, institutionErrors, staleAccounts: staleAccountNames },
      'simplefin_sync_institution_attention',
    );
  } else {
    integration.set({ status: 'connected', statusReason: null, lastSyncedAt: now });
    await integration.save();
  }
  return { runs, institutionErrors };
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
): Promise<{
  runs: SimplefinSyncAccountRun[];
  integrationsProcessed: number;
  institutionErrors: string[];
}> {
  const now = opts.now ?? new Date();
  const where: Record<string, unknown> = { status: { [Op.ne]: 'disconnected' } };
  if (opts.userId != null) where.userId = opts.userId;
  if (opts.integrationId != null) where.id = opts.integrationId;

  const integrations = await UserSimplefinIntegration.findAll({ where });
  const runs: SimplefinSyncAccountRun[] = [];
  const institutionErrors: string[] = [];
  for (const integration of integrations) {
    try {
      const result = await syncIntegration(integration, now);
      runs.push(...result.runs);
      institutionErrors.push(...result.institutionErrors);
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
        skippedCovered: 0,
        status: 'error',
      });
    }
  }
  return { runs, integrationsProcessed: integrations.length, institutionErrors };
}
