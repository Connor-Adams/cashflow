const { Router } = require('express');
const multer = require('multer');
const { runImport, importCsvFile } = require('../import/runImport');
const { ImportHistory } = require('../models');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      const e = new Error('Only .csv files are allowed');
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

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

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Missing file field "file"' });
      return;
    }
    const accountId = req.body.accountId;
    if (accountId === undefined || accountId === null || accountId === '') {
      res.status(400).json({
        error:
          'accountId is required (create an account first, then pick it here)',
      });
      return;
    }
    const batchLabel =
      req.body.batchLabel && String(req.body.batchLabel).trim()
        ? String(req.body.batchLabel).trim()
        : null;
    const profileId = req.body.profileId || null;

    const result = await importCsvFile({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      accountId,
      batchLabel,
      profileId,
    });
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
