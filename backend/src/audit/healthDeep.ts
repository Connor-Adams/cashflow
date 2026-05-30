import fs from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export interface HealthDeepResult {
  ok: boolean;
  service: 'cashflow-backend';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  db: {
    reachable: boolean;
    latencyMs: number;
    error: string | null;
  };
  migrations: {
    pending: number;
    appliedCount: number;
    headName: string | null;
    pendingNames: string[];
  };
}

export async function healthDeep(): Promise<HealthDeepResult> {
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
  let appliedCount = 0;
  let headName: string | null = null;
  let pendingNames: string[] = [];

  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    const onDisk = files.filter((f) => f.endsWith('.js')).sort();
    headName = onDisk.at(-1) ?? null;

    const appliedRows = await sequelize.query<{ name: string }>(
      'SELECT name FROM "SequelizeMeta" ORDER BY name ASC',
      { type: QueryTypes.SELECT },
    );
    const applied = new Set(appliedRows.map((r) => r.name));
    appliedCount = applied.size;
    pendingNames = onDisk.filter((f) => !applied.has(f));
  } catch {
    // If SequelizeMeta doesn't exist yet or migration dir read fails, leave defaults
  }

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
