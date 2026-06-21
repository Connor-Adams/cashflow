import fs from 'fs';
import path from 'path';
import { sequelize } from '../db';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const START = Date.now();

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

export async function runHealthDeep(): Promise<HealthDeepResult> {
  const version = process.env.GIT_SHA ?? 'dev';
  const timestamp = new Date().toISOString();
  const uptimeSeconds = Math.round(process.uptime());

  // DB reachability probe
  let dbReachable = false;
  let dbLatencyMs = 0;
  let dbError: string | null = null;
  const t0 = Date.now();
  try {
    await sequelize.authenticate();
    dbLatencyMs = Date.now() - t0;
    dbReachable = true;
  } catch (err) {
    dbLatencyMs = Date.now() - t0;
    dbError = err instanceof Error ? err.message : String(err);
  }

  // Migration check: compare on-disk files vs SequelizeMeta applied list
  let appliedNames: Set<string> = new Set();
  let appliedCount = 0;
  let diskNames: string[] = [];
  let headName: string | null = null;
  let pendingNames: string[] = [];

  try {
    diskNames = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
    headName = diskNames.length > 0 ? diskNames[diskNames.length - 1] : null;
  } catch {
    // migrations dir unreadable (e.g. dist build) — skip check
  }

  try {
    const [rows] = await sequelize.query('SELECT name FROM "SequelizeMeta"') as [Array<{ name: string }>, unknown];
    appliedNames = new Set(rows.map((r) => r.name));
    appliedCount = appliedNames.size;
  } catch {
    // SequelizeMeta may not exist in some test envs
  }

  pendingNames = diskNames.filter((n) => !appliedNames.has(n));

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

void START; // suppress unused-var lint
