/**
 * SimpleFIN explicit account-mapping service (issue #813).
 *
 * Owns the persisted SimplefinAccountLink relation: listing the caller's
 * discovered accounts with their current link state, linking a discovered
 * account to an existing or newly-created Account, and unlinking. This is the
 * single source of truth sync.ts resolves against — there is no name-based
 * re-derivation anywhere downstream.
 */
import { Op } from 'sequelize';
import {
  Account,
  SimplefinAccountLink,
  UserSimplefinIntegration,
} from '../models';
import { decryptSecret } from '../util/symmetricEncryption';
import { logger } from '../observability/logger';
import { discoverAccounts, type SimplefinDiscoveredAccount } from './client';
import { mapDiscoveredAccounts } from './service';
import type { SimplefinAccountLinkState } from '@cashflow/shared';

/** Thrown by the link service; the route maps `code` → HTTP status. */
export class SimplefinLinkError extends Error {
  constructor(
    public code:
      | 'not_connected'
      | 'discovery_failed'
      | 'not_found'
      | 'already_linked'
      | 'account_not_found'
      | 'account_not_in_household'
      | 'invalid_request',
    message: string,
    public ownedByCurrentUser = false,
  ) {
    super(message);
    this.name = 'SimplefinLinkError';
  }
}

/** Resolve the caller's integration or throw not_connected. */
async function requireIntegration(
  userId: number,
): Promise<UserSimplefinIntegration> {
  const integration = await UserSimplefinIntegration.findOne({
    where: { userId, status: { [Op.ne]: 'disconnected' } },
  });
  if (!integration) {
    throw new SimplefinLinkError('not_connected', 'No connected SimpleFIN integration.');
  }
  return integration;
}

/** Live-discover the SimpleFIN accounts for an integration (throws on failure). */
async function discoverForIntegration(
  integration: UserSimplefinIntegration,
): Promise<SimplefinDiscoveredAccount[]> {
  let accessUrl: string;
  try {
    accessUrl = decryptSecret(integration.accessUrlEncrypted);
  } catch (e) {
    logger.error(
      { integrationId: integration.id, message: e instanceof Error ? e.message : String(e) },
      'simplefin_link_decrypt_failed',
    );
    throw new SimplefinLinkError('discovery_failed', 'Could not read the SimpleFIN connection.');
  }
  try {
    return await discoverAccounts(accessUrl);
  } catch (e) {
    logger.warn(
      { integrationId: integration.id, message: e instanceof Error ? e.message : String(e) },
      'simplefin_link_discovery_failed',
    );
    throw new SimplefinLinkError('discovery_failed', 'Could not load your SimpleFIN accounts.');
  }
}

/**
 * List the caller's discovered SimpleFIN accounts with their link state.
 * `suggestedAccountId` comes from the existing last-4/name heuristic (a
 * suggestion only); `alreadyLinkedElsewhere` is true when that suggestion is
 * already claimed by a link under a different integration.
 */
export async function listDiscoveredAccounts(
  userId: number,
  householdId: number | null,
): Promise<SimplefinAccountLinkState[]> {
  const integration = await requireIntegration(userId);
  const discovered = await discoverForIntegration(integration);

  const accounts =
    householdId == null
      ? []
      : await Account.findAll({
          where: { householdId, mergedIntoId: { [Op.is]: null } },
          attributes: ['id', 'name', 'bankAccountNumber'],
        });

  // Current links for THIS integration (confirmed mappings).
  const ownLinks = await SimplefinAccountLink.findAll({
    where: { integrationId: integration.id },
  });
  const linkedBySimplefinId = new Map(
    ownLinks.map((l) => [l.simplefinAccountId, l.accountId]),
  );

  // Every account_id claimed by ANY link (to compute alreadyLinkedElsewhere).
  const allLinks = await SimplefinAccountLink.findAll({
    attributes: ['accountId', 'integrationId'],
  });
  const claimedByOther = new Map<number, number>(); // accountId -> integrationId
  for (const l of allLinks) claimedByOther.set(l.accountId, l.integrationId);

  return discovered.map((d) => {
    const linkedAccountId = linkedBySimplefinId.get(d.id) ?? null;
    // Heuristic suggestion: reuse mapDiscoveredAccounts on a single account to
    // get the unambiguous match, if any.
    // The heuristic suggestion is the single unambiguous (simplefinId →
    // accountId) match that mapDiscoveredAccounts produces, or null.
    const mapped = mapDiscoveredAccounts([d], accounts);
    const suggestedAccountId = mapped.matches[0]?.accountId ?? null;
    const claimedBy =
      suggestedAccountId != null ? claimedByOther.get(suggestedAccountId) : undefined;
    const alreadyLinkedElsewhere =
      suggestedAccountId != null &&
      claimedBy != null &&
      claimedBy !== integration.id &&
      linkedAccountId == null;
    return {
      simplefinId: d.id,
      name: d.name,
      linkedAccountId,
      suggestedAccountId,
      alreadyLinkedElsewhere,
    };
  });
}

/**
 * Link a discovered SimpleFIN account to an existing Account, or create a new
 * Account and link it. Enforces the UNIQUE(account_id) and
 * UNIQUE(integration_id, simplefin_account_id) guards at the app layer with a
 * clear 409, with the DB constraint as the backstop.
 */
export async function linkAccount(params: {
  userId: number;
  householdId: number | null;
  simplefinId: string;
  accountId?: number;
  create?: { name: string; defaultCurrency: string };
}): Promise<{ simplefinId: string; linkedAccountId: number }> {
  const { userId, householdId, simplefinId } = params;
  const integration = await requireIntegration(userId);

  // Validate exactly one of accountId / create.
  const hasExisting = params.accountId != null;
  const hasCreate = params.create != null;
  if (hasExisting === hasCreate) {
    throw new SimplefinLinkError(
      'invalid_request',
      'Provide exactly one of accountId or create.',
    );
  }

  // The simplefinId must be among the caller's discovered accounts.
  const discovered = await discoverForIntegration(integration);
  if (!discovered.some((d) => d.id === simplefinId)) {
    throw new SimplefinLinkError('not_found', 'Unknown SimpleFIN account.');
  }

  // Resolve the target Account.
  let accountId: number;
  if (hasExisting) {
    const account = await Account.findByPk(params.accountId!);
    if (!account || account.mergedIntoId != null) {
      throw new SimplefinLinkError('account_not_found', 'Account not found.');
    }
    if (householdId == null || account.householdId !== householdId) {
      throw new SimplefinLinkError(
        'account_not_in_household',
        'That account is not in your household.',
      );
    }
    accountId = account.id;
  } else {
    const name = (params.create!.name ?? '').trim();
    const currency = (params.create!.defaultCurrency ?? '').trim().toUpperCase();
    if (!name) {
      throw new SimplefinLinkError('invalid_request', 'Account name is required.');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new SimplefinLinkError('invalid_request', 'A valid currency is required.');
    }
    const created = await Account.create({
      name,
      owner: 'me',
      ownerUserId: userId,
      householdId,
      accountType: 'checking',
      defaultCurrency: currency,
    } as never);
    accountId = created.id;
  }

  // Guard UNIQUE(account_id): an account already claimed by ANY link may not be
  // re-claimed — except the idempotent no-op of re-linking the exact same
  // (integration, simplefinId) pair to the same account. A claim by a different
  // integration (cross-member / shared joint account) or a different simplefinId
  // under this integration is rejected.
  const accountClaim = await SimplefinAccountLink.findOne({ where: { accountId } });
  if (
    accountClaim &&
    !(
      accountClaim.integrationId === integration.id &&
      accountClaim.simplefinAccountId === simplefinId
    )
  ) {
    throw new SimplefinLinkError(
      'already_linked',
      'That account is already linked to a SimpleFIN account.',
      accountClaim.integrationId === integration.id,
    );
  }

  // Upsert the link for (integration, simplefinId). If this simplefinId already
  // points at a different account, re-point it (idempotent confirm/relink).
  const existing = await SimplefinAccountLink.findOne({
    where: { integrationId: integration.id, simplefinAccountId: simplefinId },
  });
  if (existing) {
    if (existing.accountId !== accountId) {
      existing.set({ accountId });
      await existing.save();
    }
  } else {
    await SimplefinAccountLink.create({
      integrationId: integration.id,
      simplefinAccountId: simplefinId,
      accountId,
    });
  }

  return { simplefinId, linkedAccountId: accountId };
}

/**
 * Remove the link for a discovered account (idempotent). Leaves the Account and
 * any previously imported transactions intact.
 */
export async function unlinkAccount(
  userId: number,
  simplefinId: string,
): Promise<{ simplefinId: string; linkedAccountId: null }> {
  const integration = await requireIntegration(userId);
  await SimplefinAccountLink.destroy({
    where: { integrationId: integration.id, simplefinAccountId: simplefinId },
  });
  return { simplefinId, linkedAccountId: null };
}
