import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { runTransferContactLink, isTransferLinkRunning } from '../import/transferContactLink';

const router = Router();

router.get('/status', (req, res) => {
  const { household } = currentAuth(req);
  res.json({ running: isTransferLinkRunning(household.id) });
});

router.post('/preview', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    res.json(await runTransferContactLink({ householdId: household.id, dryRun: true }));
  } catch (e) {
    next(e);
  }
});

router.post('/commit', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    if (isTransferLinkRunning(household.id)) {
      res.status(409).json({ error: 'Transfer link already running for this household' });
      return;
    }
    res.json(await runTransferContactLink({ householdId: household.id }));
  } catch (e) {
    next(e);
  }
});

export default router;
