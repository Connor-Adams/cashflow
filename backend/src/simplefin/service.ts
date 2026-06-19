/**
 * SimpleFIN connection service (issue #790).
 *
 * Owns persistence + business logic for the SimpleFIN credential store:
 *   - connect: exchange a setup token, encrypt + upsert the access URL, then run
 *     a one-time account discovery and map discovered accounts to Account rows.
 *   - status: report masked connection state (never credentials).
 *   - disconnect: delete the row (idempotent).
 *
 * The recurring transaction sync is explicitly OUT OF SCOPE (issue #791) — this
 * service never writes Transaction rows.
 */
import { Op } from 'sequelize';
import { Account, UserSimplefinIntegration } from '../models';
import { encryptSecret } from '../util/symmetricEncryption';
import { logger } from '../observability/logger';
import type { SimplefinUnlinkedAccount } from '@cashflow/shared';
import {
  type SimplefinDiscoveredAccount,
  claimAccessUrl,
  decodeSetupToken,
  discoverAccounts,
  maskAccessUrlHost,
} from './client';

export interface SimplefinConnectResult {
  status: 'connected';
  accountsFound: number;
  accountsLinked: number;
  unlinkedAccounts: SimplefinUnlinkedAccount[];
}

export interface SimplefinStatusResult {
  connected: boolean;
  status: 'connected' | 'error' | 'disconnected';
  statusReason: string | null;
  lastSyncedAt: string | null;
  host: string | null;
}

/** Normalize an account identifier for fuzzy matching (case/space-insensitive). */
function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Last 4 digits of an account-number-like string, or '' if none. */
function last4(s: string | null | undefined): string {
  const digits = (s ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

/**
 * Map discovered SimpleFIN accounts to existing Account rows within a household.
 * An account links when there is an UNAMBIGUOUS match by bankAccountNumber
 * (last-4) or, failing that, by normalized name. Ambiguous (multiple) matches
 * are treated as unlinked so we never link to the wrong account.
 */
export function mapDiscoveredAccounts(
  discovered: SimplefinDiscoveredAccount[],
  accounts: Pick<Account, 'id' | 'name' | 'bankAccountNumber'>[],
): { linked: number; unlinked: SimplefinUnlinkedAccount[] } {
  let linked = 0;
  const unlinked: SimplefinUnlinkedAccount[] = [];

  for (const d of discovered) {
    const dLast4 = last4(d.accountNumber);
    let matches: typeof accounts = [];
    if (dLast4) {
      matches = accounts.filter((a) => last4(a.bankAccountNumber) === dLast4);
    }
    if (matches.length === 0) {
      const dName = norm(d.name);
      if (dName) matches = accounts.filter((a) => norm(a.name) === dName);
    }
    if (matches.length === 1) {
      linked += 1;
    } else {
      unlinked.push({ simplefinId: d.id, name: d.name });
    }
  }
  return { linked, unlinked };
}

/**
 * Exchange a setup token and persist the encrypted access URL for `userId`.
 * Upserts (one row per user). Runs a one-time account discovery scoped to
 * `householdId` and returns the mapping summary. Throws SimplefinError on
 * invalid token / claim failure; other (encryption/persist) errors propagate
 * so the route can map them to storage_failed.
 */
export async function connect(params: {
  userId: number;
  householdId: number | null;
  setupToken: string;
}): Promise<SimplefinConnectResult> {
  const { userId, householdId, setupToken } = params;

  // 1. Decode + validate the setup token (throws invalid_setup_token).
  const claimUrl = decodeSetupToken(setupToken);

  // 2. Exchange for the permanent access URL (throws claim_exchange_failed).
  const accessUrl = await claimAccessUrl(claimUrl);

  // 3. Encrypt + upsert. Encryption failure (missing key) propagates → storage_failed.
  const accessUrlEncrypted = encryptSecret(accessUrl);
  const existing = await UserSimplefinIntegration.findOne({ where: { userId } });
  if (existing) {
    existing.set({
      accessUrlEncrypted,
      status: 'connected',
      statusReason: null,
    });
    await existing.save();
  } else {
    await UserSimplefinIntegration.create({
      userId,
      accessUrlEncrypted,
      status: 'connected',
      statusReason: null,
      lastSyncedAt: null,
    });
  }

  // 4. One-time account discovery + mapping. Discovery failure must NOT undo the
  //    successful connection — surface it as zero linked accounts and log it.
  let accountsFound = 0;
  let accountsLinked = 0;
  let unlinkedAccounts: SimplefinUnlinkedAccount[] = [];
  try {
    const discovered = await discoverAccounts(accessUrl);
    accountsFound = discovered.length;
    const accounts =
      householdId == null
        ? []
        : await Account.findAll({
            where: { householdId, mergedIntoId: { [Op.is]: null } },
            attributes: ['id', 'name', 'bankAccountNumber'],
          });
    const mapped = mapDiscoveredAccounts(discovered, accounts);
    accountsLinked = mapped.linked;
    unlinkedAccounts = mapped.unlinked;
  } catch (e) {
    logger.warn(
      { userId, message: e instanceof Error ? e.message : String(e) },
      'simplefin_discovery_failed',
    );
    // Discovery is best-effort; connection itself succeeded.
    accountsFound = 0;
    accountsLinked = 0;
    unlinkedAccounts = [];
  }

  return {
    status: 'connected',
    accountsFound,
    accountsLinked,
    unlinkedAccounts,
  };
}

/** Report masked connection state for a user. Never returns credentials. */
export async function status(userId: number): Promise<SimplefinStatusResult> {
  const row = await UserSimplefinIntegration.findOne({ where: { userId } });
  if (!row) {
    return {
      connected: false,
      status: 'disconnected',
      statusReason: null,
      lastSyncedAt: null,
      host: null,
    };
  }
  let host: string | null = null;
  try {
    const { decryptSecret } = await import('../util/symmetricEncryption');
    host = maskAccessUrlHost(decryptSecret(row.accessUrlEncrypted));
  } catch {
    host = null;
  }
  return {
    connected: row.status === 'connected',
    status: row.status as SimplefinStatusResult['status'],
    statusReason: row.statusReason ?? null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    host,
  };
}

/** Delete the connection. Idempotent — no error when none exists. */
export async function disconnect(userId: number): Promise<void> {
  const row = await UserSimplefinIntegration.findOne({ where: { userId } });
  if (!row) return;
  await row.destroy();
}
