import { Router } from 'express';
import { Account, Transaction, sequelize } from '../models';
import * as env from '../config/env';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await Account.findAll({ order: [['name', 'ASC']] });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, owner, shortCode, defaultCurrency } = (req.body || {}) as Record<
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
      shortCode: (shortCode as string) || null,
      defaultCurrency: dc,
    });
    res.status(201).json(row);
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
    const account = await Account.findByPk(id);
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { name, owner, shortCode, defaultCurrency } = (req.body || {}) as Record<
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
    const account = await Account.findByPk(id);
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
