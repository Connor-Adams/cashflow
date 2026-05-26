import { Router, type Request, type Response } from 'express';
import cron from 'node-cron';
import { HouseholdMember, Job } from '../models';
import { currentAuth } from '../auth/middleware';
import { aiSuggestLimiter } from '../routes/aiRateLimit';
import { isTickRunning } from './runner';
import { listJobs, runJobByName, listDefinitions, listJobRuns } from './registry';

const router = Router();
const manualRuns = new Set<string>();

// Authenticated operator endpoints can trigger backend work, so rate-limit
// the router per CodeQL guidance. The limiter skips NODE_ENV=test.
router.use(aiSuggestLimiter);

router.use((req: Request, res: Response, next) => {
  const auth = currentAuth(req);
  if (auth.user.globalRole !== 'superadmin' && auth.role !== 'owner') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
});

router.get('/', async (_req, res) => {
  const views = await listJobs();
  res.json(views);
});

router.get('/:name/runs', async (req, res) => {
  const name = req.params.name;
  const def = listDefinitions().find((d) => d.name === name);
  if (!def) {
    res.status(404).json({ error: 'unknown_job' });
    return;
  }
  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 10;
  const runs = await listJobRuns(name, Number.isFinite(rawLimit) ? rawLimit : 10);
  res.json(runs);
});

router.patch('/:name', async (req, res) => {
  const name = req.params.name;
  const def = listDefinitions().find((d) => d.name === name);
  if (!def) {
    res.status(404).json({ error: 'unknown_job' });
    return;
  }
  const body = req.body as { enabled?: boolean | null; cron?: string | null };
  if (body.cron !== undefined && body.cron !== null && !cron.validate(body.cron)) {
    res.status(400).json({ error: 'invalid_cron' });
    return;
  }
  const patch: Partial<{ enabledOverride: boolean | null; cronOverride: string | null }> = {};
  if (body.enabled !== undefined) patch.enabledOverride = body.enabled;
  if (body.cron !== undefined) patch.cronOverride = body.cron;

  const [row] = await Job.findOrCreate({
    where: { name },
    defaults: {
      name,
      enabledOverride: null,
      cronOverride: null,
      lastRunAt: null,
      lastFinishedAt: null,
      lastStatus: null,
      lastDurationMs: null,
      lastError: null,
      lastResultJson: null,
    },
  });
  await row.update(patch);

  const views = await listJobs();
  const view = views.find((v) => v.name === name);
  res.json(view);
});

router.post('/:name/run', async (req, res) => {
  const name = req.params.name;
  const def = listDefinitions().find((d) => d.name === name);
  if (!def) {
    res.status(404).json({ error: 'unknown_job' });
    return;
  }
  if (manualRuns.has(name) || isTickRunning(name)) {
    res.status(409).json({ error: 'JOB_ALREADY_RUNNING' });
    return;
  }
  manualRuns.add(name);
  try {
    const auth = currentAuth(req);
    const owners = await HouseholdMember.findAll({
      where: { householdId: auth.household.id, role: 'owner' },
      attributes: ['userId'],
    });
    const outcome = await runJobByName(name, {
      failureNotificationUserIds: owners.map((owner) => owner.userId),
    });
    res.json(outcome);
  } finally {
    manualRuns.delete(name);
  }
});

export default router;
