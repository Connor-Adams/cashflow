import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export type HealthDeepResult = {
  ok: boolean;
  service: 'cashflow-backend';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  db: { reachable: boolean; latencyMs: number; error: string | null };
  migrations: {
    pending: number;
    appliedCount: number;
    headName: string | null;
    pendingNames: string[];
  };
};

export async function buildHealthDeep(): Promise<HealthDeepResult> {
  const version = process.env.APP_VERSION ?? 'dev';
  const uptimeSeconds = Math.floor(process.uptime());
  const timestamp = new Date().toISOString();

  // DB probe
  let dbReachable = false;
  let dbLatencyMs = 0;
  let dbError: string | null = null;
  try {
    const start = Date.now();
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
    dbLatencyMs = Date.now() - start;
    dbReachable = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  // Migration probe
  let onDisk: string[] = [];
  try {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    onDisk = files.filter((f) => f.endsWith('.js')).sort();
  } catch {
    // migrations dir unreadable (e.g. built bundle)
  }

  let appliedSet = new Set<string>();
  let appliedCount = 0;
  if (dbReachable) {
    try {
      const rows = await sequelize.query<{ name: string }>(
        'SELECT name FROM "SequelizeMeta" ORDER BY name ASC',
        { type: QueryTypes.SELECT },
      );
      appliedSet = new Set(rows.map((r) => r.name));
      appliedCount = rows.length;
    } catch {
      // SequelizeMeta may not exist on a fresh DB
    }
  }

  const pendingNames = onDisk.filter((f) => !appliedSet.has(f));
  const headName = onDisk.length > 0 ? onDisk[onDisk.length - 1] : null;

  const ok = dbReachable && pendingNames.length === 0;

  return {
    ok,
    service: 'cashflow-backend',
    version,
    uptimeSeconds,
    timestamp,
    db: { reachable: dbReachable, latencyMs: dbLatencyMs, error: dbError },
    migrations: {
      pending: pendingNames.length,
      appliedCount,
      headName,
      pendingNames,
    },
  };
}
