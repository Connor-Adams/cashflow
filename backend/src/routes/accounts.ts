import { Router } from 'express';
import { Account, Transaction, sequelize } from '../models';
import * as env from '../config/env';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
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
    const rows = await Account.findAll({
      where: visibleAccountWhere(req),
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

export default router;
