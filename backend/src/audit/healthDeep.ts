import fs from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';

export interface HealthDeepResult {
  ok: boolean;
  service: string;
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
}

async function probeDb(): Promise<HealthDeepResult['db']> {
  const start = Date.now();
  try {
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
    return { reachable: true, latencyMs: Date.now() - start, error: null };
  } catch (e) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: String((e as Error)?.message ?? e),
    };
  }
}

async function probeMigrations(): Promise<HealthDeepResult['migrations']> {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  let onDisk: string[] = [];
  try {
    onDisk = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.js')).sort();
  } catch {
    onDisk = [];
  }
  type Row = { name: string };
  let applied: Row[] = [];
  try {
    applied = await sequelize.query<Row>(
      'SELECT name FROM "SequelizeMeta" ORDER BY name ASC',
      { type: QueryTypes.SELECT },
    );
  } catch {
    applied = [];
  }
  const appliedSet = new Set(applied.map((r) => r.name));
  const pendingNames = onDisk.filter((n) => !appliedSet.has(n));
  const headName = onDisk.length > 0 ? onDisk[onDisk.length - 1] : null;
  return {
    pending: pendingNames.length,
    appliedCount: applied.length,
    headName,
    pendingNames,
  };
}

export async function healthDeep(): Promise<HealthDeepResult> {
  const [db, migrations] = await Promise.all([probeDb(), probeMigrations()]);
  return {
    ok: db.reachable && migrations.pending === 0,
    service: 'cashflow-backend',
    version: process.env.APP_VERSION ?? 'dev',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    db,
    migrations,
  };
}
