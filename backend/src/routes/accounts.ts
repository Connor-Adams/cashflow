import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, LiabilityAccount, Transaction, sequelize } from '../models';
import * as env from '../config/env';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { pendingTotal } from '../transactions/status';
import { currentOwed, utilizationPct } from '../cards/utilization';

const CREDIT_CARD_TYPE = 'credit_card';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialize an account with #437 enrichment: creditLimit (from the
 * liability_accounts sidecar) and utilizationPct (derived from the
 * transaction stream). Both are null for non-credit-card accounts and for
 * credit cards without a limit set. Closed cards report null utilizationPct
 * so they fall out of badges + Dashboard summaries.
 */
const NOTES_MAX_LEN = 4000;
const NOTES_PREVIEW_LEN = 100;

function notesPreview(notes: string | null): string | null {
  if (!notes) return null;
  const trimmed = notes.trim();
  if (!trimmed) return null;
  return trimmed.length > NOTES_PREVIEW_LEN ? trimmed.slice(0, NOTES_PREVIEW_LEN) : trimmed;
}

async function enrichAccount(
  account: InstanceType<typeof Account>,
  profileByAccount: Map<number, InstanceType<typeof LiabilityAccount>>,
  asOf: string,
  opts: { fullNotes?: boolean } = {},
): Promise<Record<string, unknown>> {
  const base = account.toJSON() as Record<string, unknown>;
  // Truncate notes to preview length on list endpoint; expose full on detail.
  if (opts.fullNotes) {
    base.notesPreview = notesPreview(account.notes);
  } else {
    base.notesPreview = notesPreview(account.notes);
    delete base.notes;
  }
  if (account.accountType !== CREDIT_CARD_TYPE) {
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
    const rows = await Account.findAll({
      where: visibleAccountWhere(req),
      order: [['name', 'ASC']],
    });
    const ccIds = rows.filter((a) => a.accountType === CREDIT_CARD_TYPE).map((a) => a.id);
    const profiles =
      ccIds.length > 0
        ? await LiabilityAccount.findAll({ where: { accountId: { [Op.in]: ccIds } } })
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
    if (notes !== undefined && notes !== null) {
      const trimmed = String(notes).trim();
      if (trimmed.length > NOTES_MAX_LEN) {
        res.status(400).json({ error: 'NOTES_TOO_LONG' });
        return;
      }
    }
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
      notes: notes != null ? String(notes).trim() || null : null,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
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
    const profile = await LiabilityAccount.findOne({ where: { accountId: id } });
    const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
    if (profile) profileByAccount.set(profile.accountId, profile);
    const enriched = await enrichAccount(account, profileByAccount, todayIso(), { fullNotes: true });
    res.json(enriched);
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
      if (notes === null || notes === '') {
        account.set('notes', null);
      } else {
        const trimmed = String(notes).trim();
        if (trimmed.length > NOTES_MAX_LEN) {
          res.status(400).json({ error: 'NOTES_TOO_LONG' });
          return;
        }
        account.set('notes', trimmed || null);
      }
    }

    // creditLimit lives on the liability_accounts sidecar (#437). Only valid
    // for credit_card accounts; sending a non-null value for any other kind is
    // a 400 to avoid stranded data on a row that nothing will ever read.
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
      if (effectiveType !== CREDIT_CARD_TYPE && nextCreditLimit !== null) {
        res
          .status(400)
          .json({ error: 'creditLimit can only be set on credit_card accounts' });
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
    const enriched = await enrichAccount(account, profileByAccount, todayIso(), { fullNotes: true });
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
    await sequelize.transaction(async (t) => {
      await Transaction.destroy({ where: { accountId: id }, transaction: t });
      await account.destroy({ transaction: t });
    });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
