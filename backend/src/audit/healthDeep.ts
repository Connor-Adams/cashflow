import fs from 'fs/promises';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';

export async function buildHealthDeep() {
  const start = Date.now();
  let dbReachable = true;
  let dbError: string | null = null;
  try {
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
  } catch (e: unknown) {
    dbReachable = false;
    dbError = e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Date.now() - start;

  // Migration probe
  let appliedNames: string[] = [];
  try {
    const rows = await sequelize.query<{ name: string }>(
      'SELECT name FROM "SequelizeMeta" ORDER BY name ASC',
      { type: QueryTypes.SELECT },
    );
    appliedNames = rows.map((r) => r.name);
  } catch {
    // SequelizeMeta might not exist in test DBs
  }

  const migrationsDir = path.resolve(__dirname, '../migrations');
  let diskNames: string[] = [];
  try {
    const files = await fs.readdir(migrationsDir);
    diskNames = files.filter((f) => f.endsWith('.js')).sort();
  } catch {
    // fallback: empty
  }

  const appliedSet = new Set(appliedNames);
  const pendingNames = diskNames.filter((n) => !appliedSet.has(n));
  const headName = diskNames.length > 0 ? diskNames[diskNames.length - 1] : null;

  const ok = dbReachable && pendingNames.length === 0;

  return {
    ok,
    service: 'cashflow-backend' as const,
    version: process.env.APP_VERSION ?? 'dev',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: { reachable: dbReachable, latencyMs, error: dbError },
    migrations: {
      pending: pendingNames.length,
      appliedCount: appliedNames.length,
      headName,
      pendingNames,
    },
  };
}
