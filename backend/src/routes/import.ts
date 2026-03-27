import { Router } from 'express';
import multer from 'multer';
import { runImport, importCsvFile } from '../import/runImport';
import { ImportHistory } from '../models';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      const e = new Error('Only .csv files are allowed') as Error & { status?: number };
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
    const profileId = (req.body as { profileId?: string } | undefined)?.profileId;
    const result = await runImport({ profileId });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post(
  '/upload',
  (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const accountId = (req.body as { accountId?: string }).accountId;
      if (accountId === undefined || accountId === null || accountId === '') {
        res.status(400).json({
          error:
            'accountId is required (create an account first, then pick it here)',
        });
        return;
      }
      const batchLabel =
        (req.body as { batchLabel?: string }).batchLabel &&
        String((req.body as { batchLabel?: string }).batchLabel).trim()
          ? String((req.body as { batchLabel?: string }).batchLabel).trim()
          : null;
      const profileId = (req.body as { profileId?: string }).profileId || null;

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
  }
);

router.get('/history', async (_req, res, next) => {
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

export default router;
