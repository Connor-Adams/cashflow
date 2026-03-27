const { Router } = require('express');
const { Account } = require('../models');

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
    const row = await Account.create({
      name,
      owner: owner || 'me',
      shortCode: shortCode || null,
      defaultCurrency: defaultCurrency || null,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
