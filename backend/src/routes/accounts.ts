import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, LiabilityAccount, Transaction, sequelize } from '../models';
import * as env from '../config/env';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { pendingTotal } from '../transactions/status';
import { currentOwed, utilizationPct } from '../cards/utilization';
import {
  mergeAccounts,
  hasMergedSources,
  AccountMergeError,
} from '../accounts/accountMerge';

// Revolving-credit kinds carry a creditLimit + utilization (#437). Credit cards
// and lines of credit (stored as the `loan` type) both draw against a limit, and
// currentOwed() keys off any negative balance, so the drawn/limit math is
// identical. Term loans share the `loan` kind but have no revolving limit — the
// limit stays optional, so this never forces a figure onto one.
const REVOLVING_CREDIT_TYPES = new Set(['credit_card', 'loan']);
function isRevolvingCredit(accountType: string): boolean {
  return REVOLVING_CREDIT_TYPES.has(accountType);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialize an account with #437 enrichment: creditLimit (from the
 * liability_accounts sidecar) and utilizationPct (derived from the
 * transaction stream). Both are null for non-revolving accounts and for
 * revolving accounts (credit cards / lines of credit) without a limit set.
 * Closed accounts report null utilizationPct so they fall out of badges.
 */
async function enrichAccount(
  account: InstanceType<typeof Account>,
  profileByAccount: Map<number, InstanceType<typeof LiabilityAccount>>,
  asOf: string,
): Promise<Record<string, unknown>> {
  const base = account.toJSON() as Record<string, unknown>;
  if (!isRevolvingCredit(account.accountType)) {
    base.creditLimit = null;
    base.currentBalance = null;
    base.utilizationPct = null;
    return base;
  }
  const profile = profileByAccount.get(account.id) ?? null;
  const creditLimit =
    profile && profile.creditLimit != null ? Number(profile.creditLimit) : null;
  const isClosed = Boolean(account.closedAt && account.closedAt <= asOf);
  const balance = await currentOwed(account, asOf);
  base.creditLimit = creditLimit;
  base.currentBalance = balance;
  base.utilizationPct = isClosed ? null : utilizationPct(balance, creditLimit);
  return base;
}

const router = Router();
const ACCOUNT_TYPES = new Set([
  'checking',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
  'other',
]);

function normalizeAccountType(raw: unknown): string {
  const value = String(raw ?? '').trim();
  return ACCOUNT_TYPES.has(value) ? value : 'checking';
}

router.get('/', async (req, res, next) => {
  try {
    // Merged-source accounts (#287) are hidden from the default list. Pass
    // ?includeMerged=true to surface them (the "Hidden / merged" UI section).
    const includeMerged = req.query.includeMerged === 'true';
    const where = includeMerged
      ? visibleAccountWhere(req)
      : { ...visibleAccountWhere(req), mergedIntoId: null };
    const rows = await Account.findAll({
      where,
      order: [['name', 'ASC']],
    });
    const revolvingIds = rows.filter((a) => isRevolvingCredit(a.accountType)).map((a) => a.id);
    const profiles =
      revolvingIds.length > 0
        ? await LiabilityAccount.findAll({ where: { accountId: { [Op.in]: revolvingIds } } })
        : [];
    const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
    for (const p of profiles) profileByAccount.set(p.accountId, p);
    const asOf = todayIso();
    const enriched = await Promise.all(
      rows.map((a) => enrichAccount(a, profileByAccount, asOf)),
    );
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const { name, owner, shortCode, defaultCurrency, visibility, accountType, notes } = (req.body || {}) as Record<
      string,
      unknown
    >;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const notesValue = notes != null ? String(notes).slice(0, 4000) || null : null;
    const dc =
      defaultCurrency != null && String(defaultCurrency).trim() !== ''
        ? String(defaultCurrency).trim().toUpperCase().slice(0, 3)
        : env.defaultCurrency;
    const row = await Account.create({
      name: String(name),
      owner: (owner as string) || 'me',
      householdId: household.id,
      ownerUserId: user.id,
      visibility: visibility === 'shared' ? 'shared' : 'private',
      accountType: normalizeAccountType(accountType),
      shortCode: (shortCode as string) || null,
      defaultCurrency: dc,
      notes: notesValue,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/pending-total', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const asOf =
      typeof req.query.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf)
        ? req.query.asOf
        : null;
    res.json(await pendingTotal({ accountId: account.id, householdId: account.householdId, asOf }));
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { name, owner, shortCode, defaultCurrency, visibility, accountType, closedAt, creditLimit, notes } =
      (req.body || {}) as Record<string, unknown>;
    if (name !== undefined) {
      const value = String(name).trim();
      if (!value) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      account.set('name', value);
    }
    if (owner !== undefined) {
      const value = String(owner).trim();
      if (!value) {
        res.status(400).json({ error: 'owner cannot be empty' });
        return;
      }
      account.set('owner', value);
    }
    if (shortCode !== undefined) {
      const value = String(shortCode).trim();
      account.set('shortCode', value || null);
    }
    if (defaultCurrency !== undefined) {
      const value = String(defaultCurrency).trim();
      account.set(
        'defaultCurrency',
        value ? value.toUpperCase().slice(0, 3) : env.defaultCurrency
      );
    }
    if (visibility !== undefined) {
      account.set('visibility', visibility === 'shared' ? 'shared' : 'private');
    }
    if (accountType !== undefined) {
      account.set('accountType', normalizeAccountType(accountType));
    }
    if (closedAt !== undefined) {
      if (closedAt === null || closedAt === '') {
        account.set('closedAt', null);
      } else {
        const raw = String(closedAt).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          res.status(400).json({ error: 'closedAt must be YYYY-MM-DD or null' });
          return;
        }
        account.set('closedAt', raw);
      }
    }
    if (notes !== undefined) {
      const raw = notes === null ? null : String(notes);
      if (raw !== null && raw.length > 4000) {
        res.status(400).json({ error: 'NOTES_TOO_LONG' });
        return;
      }
      account.set('notes', raw === '' ? null : raw);
    }

    // creditLimit lives on the liability_accounts sidecar (#437). Only valid
    // for revolving credit (credit_card / loan lines of credit); sending a
    // non-null value for any other kind is a 400 to avoid stranded data on a
    // row that nothing will ever read.
    let nextCreditLimit: number | null | undefined = undefined;
    if (creditLimit !== undefined) {
      if (creditLimit === null || creditLimit === '') {
        nextCreditLimit = null;
      } else {
        const n = Number(creditLimit);
        if (!Number.isFinite(n) || n <= 0) {
          res.status(400).json({ error: 'creditLimit must be greater than 0 or null' });
          return;
        }
        nextCreditLimit = n;
      }
      // The effective accountType after this PATCH determines whether the
      // limit is allowed. Caller may be flipping kind in the same request.
      const effectiveType = account.accountType;
      if (!isRevolvingCredit(effectiveType) && nextCreditLimit !== null) {
        res
          .status(400)
          .json({ error: 'creditLimit can only be set on credit_card or loan accounts' });
        return;
      }
    }

    await account.save();

    if (nextCreditLimit !== undefined) {
      const existing = await LiabilityAccount.findOne({ where: { accountId: account.id } });
      if (existing) {
        existing.set(
          'creditLimit',
          nextCreditLimit == null ? null : nextCreditLimit.toFixed(4),
        );
        await existing.save();
      } else if (nextCreditLimit !== null) {
        await LiabilityAccount.create({
          accountId: account.id,
          householdId: household.id,
          creditLimit: nextCreditLimit.toFixed(4),
        });
      }
      // If existing is null AND nextCreditLimit is null: nothing to persist.
    }

    const profile = await LiabilityAccount.findOne({ where: { accountId: account.id } });
    const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
    if (profile) profileByAccount.set(profile.accountId, profile);
    const enriched = await enrichAccount(account, profileByAccount, todayIso());
    res.json(enriched);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Block deleting an account that is the target of a merge (#287): sources
    // point at it via merged_into_id (ON DELETE RESTRICT). Surface a clean 400
    // rather than a raw FK error so the client can explain it.
    const { household } = currentAuth(req);
    if (await hasMergedSources(id, household.id)) {
      res.status(400).json({ error: 'ACCOUNT_HAS_MERGED_SOURCES' });
      return;
    }
    await sequelize.transaction(async (t) => {
      await Transaction.destroy({ where: { accountId: id }, transaction: t });
      await account.destroy({ transaction: t });
    });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// Merge / consolidate a duplicate account into another (#287). Soft-merge:
// reassigns the source's child records to the target and flags the source
// (mergedIntoId/mergedAt), preserving it read-only for audit. The path segment
// `/merge-into/` keeps this from colliding with the `/:id` PATCH/DELETE routes.
const MERGE_ERROR_STATUS: Record<string, number> = {
  SAME_ID: 400,
  CURRENCY_MISMATCH: 400,
  TARGET_NOT_MERGEABLE: 400,
  SOURCE_ALREADY_MERGED: 400,
  NOT_FOUND: 404,
};

router.post('/:sourceId/merge-into/:targetId', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const sourceId = parseInt(req.params.sourceId, 10);
    const targetId = parseInt(req.params.targetId, 10);
    if (Number.isNaN(sourceId) || Number.isNaN(targetId)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    // Ownership is enforced inside mergeAccounts (scoped to householdId).
    // Superadmins still operate within their own household for this action.
    const result = await mergeAccounts({ sourceId, targetId, householdId: household.id });
    res.json({
      source: result.source.toJSON(),
      target: result.target.toJSON(),
      movedTransactions: result.movedTransactions,
      movedPlannedEvents: result.movedPlannedEvents,
      movedTotal: result.movedTotal,
    });
  } catch (e) {
    if (e instanceof AccountMergeError) {
      res
        .status(MERGE_ERROR_STATUS[e.code] ?? 400)
        .json({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
      return;
    }
    next(e);
  }
});

export default router;
