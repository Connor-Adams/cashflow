const { Router } = require('express');
const { runImport } = require('../import/runImport');
const { ImportHistory } = require('../models');

const router = Router();

router.post('/run', async (req, res, next) => {
  try {
    const profileId = req.body?.profileId;
    const result = await runImport({ profileId });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const rows = await ImportHistory.findAll({
      order: [['startedAt', 'DESC']],
      limit: 50,
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
