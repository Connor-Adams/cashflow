import { Router } from 'express';
import { Account, Transaction, sequelize } from '../models';
import * as env from '../config/env';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { mergeAccounts, mergedAccountFilter } from '../services/accountMerge';
import { pendingTotal } from '../transactions/status';

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
    const includeMerged = req.query.includeMerged === 'true';
    const rows = await Account.findAll({
      where: {
        ...visibleAccountWhere(req),
        ...mergedAccountFilter(includeMerged),
      },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const { name, owner, shortCode, defaultCurrency, visibility, accountType } = (req.body || {}) as Record<
      string,
      unknown
    >;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
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
    const { name, owner, shortCode, defaultCurrency, visibility, accountType, closedAt } = (req.body || {}) as Record<
      string,
      unknown
    >;
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
    await account.save();
    res.json(account);
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

router.post('/:sourceId/merge-into/:targetId', async (req, res, next) => {
  try {
    const sourceId = parseInt(req.params.sourceId, 10);
    const targetId = parseInt(req.params.targetId, 10);
    if (Number.isNaN(sourceId) || Number.isNaN(targetId)) {
      res.status(400).json({ error: 'Invalid account id' });
      return;
    }

    const { household } = currentAuth(req);
    const result = await mergeAccounts(household.id, sourceId, targetId);

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case 'SAME_ID':
          res.status(400).json({ error: 'SAME_ID', message: 'Source and target must be different accounts.' });
          return;
        case 'SOURCE_NOT_FOUND':
        case 'TARGET_NOT_FOUND':
          res.status(404).json({ error: error.code, message: 'Account not found.' });
          return;
        case 'CURRENCY_MISMATCH':
          res.status(400).json({
            error: 'CURRENCY_MISMATCH',
            message: `Accounts must be in the same currency. Source: ${error.sourceCurrency}; Target: ${error.targetCurrency}.`,
            sourceCurrency: error.sourceCurrency,
            targetCurrency: error.targetCurrency,
          });
          return;
        case 'TARGET_NOT_MERGEABLE':
          res.status(400).json({ error: 'TARGET_NOT_MERGEABLE', message: 'Target has already been merged into another account.' });
          return;
        case 'SOURCE_ALREADY_MERGED':
          res.status(400).json({ error: 'SOURCE_ALREADY_MERGED', message: 'Source account has already been merged.' });
          return;
      }
    }

    res.json({
      source: result.source,
      target: result.target,
      movedTransactions: result.movedTransactions,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
