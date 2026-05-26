import { Router, type Request, type Response } from 'express';
import cron from 'node-cron';
import { Job } from '../models';
import { isSuperadmin } from '../auth/scope';
import { listJobs, runJobByName, listDefinitions } from './registry';

const router = Router();

router.use((req: Request, res: Response, next) => {
  if (!isSuperadmin(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
});

router.get('/', async (_req, res) => {
  const views = await listJobs();
  res.json(views);
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
  const outcome = await runJobByName(name);
  res.json(outcome);
});

export default router;
