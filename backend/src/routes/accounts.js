const { Router } = require('express');
const { Account, Transaction, sequelize } = require('../models');
const env = require('../config/env');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Account.findAll({ order: [['name', 'ASC']] });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, owner, shortCode, defaultCurrency } = req.body || {};
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const dc =
      defaultCurrency != null && String(defaultCurrency).trim() !== ''
        ? String(defaultCurrency).trim().toUpperCase().slice(0, 3)
        : env.defaultCurrency;
    const row = await Account.create({
      name,
      owner: owner || 'me',
      shortCode: shortCode || null,
      defaultCurrency: dc,
    });
    res.status(201).json(row);
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

module.exports = router;
