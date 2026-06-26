import { Router } from 'express';
import { sequelize } from '../db';

const router = Router();

/** Max time the readiness DB probe may take before it's treated as a failure. */
const READINESS_TIMEOUT_MS = 2000;

/**
 * Run a lightweight `SELECT 1` against the DB, bounded by a timeout so a hung
 * connection can't wedge the readiness probe. Resolves true if the DB answered
 * in time, false if the query rejected or the timeout fired first.
 */
export async function checkDbReady(timeoutMs: number = READINESS_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const probe = sequelize
    .query('SELECT 1')
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Liveness: process is up. No I/O — never depends on the DB, so a Postgres
// blip can't trigger a restart loop.
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'cashflow-backend',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: can the process actually serve? Probes the DB with a bounded
// `SELECT 1`. 503 when the DB is unreachable so the orchestrator stops routing
// traffic to an API that can only return 500s.
router.get('/ready', async (_req, res) => {
  const dbReady = await checkDbReady();
  if (dbReady) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

export default router;
