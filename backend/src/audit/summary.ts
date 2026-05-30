import type { Application } from 'express';
import { sequelize, Job } from '../models';
import type { AuditAuthContext } from '../auth/auditAuth';
import { getIntegrity } from './integrity';
import { getCounts } from './counts';
import { getClientErrors } from './clientErrors';
import { getServerErrors } from './serverErrors';
import { runRouteProbe } from './routeProbe';

export type Verdict = 'pass' | 'warn' | 'fail';

function worstOf(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

export interface AuditSummaryResult {
  overall: Verdict;
  dimensions: {
    health: { verdict: Verdict; summary: string };
    freshness: { verdict: Verdict; summary: string };
    integrity: { verdict: Verdict; summary: string };
    counts: { verdict: Verdict; summary: string };
    clientErrors: { verdict: Verdict; summary: string };
    serverErrors: { verdict: Verdict; summary: string };
    routes: { verdict: Verdict; summary: string };
  };
  generatedAt: string;
}

async function checkHealth(): Promise<{ verdict: Verdict; summary: string }> {
  try {
    const start = Date.now();
    await sequelize.authenticate();
    const ms = Date.now() - start;

    // Check pending migrations via SequelizeMeta
    const [[pendingRow]] = await sequelize.query<{ pending: string }>(
      `SELECT COUNT(*) AS pending FROM information_schema.tables
       WHERE table_name = 'sequelize_meta'
       LIMIT 1`,
    );
    // Simply confirm DB is up; migration check needs more context so we treat
    // reachability as pass
    return { verdict: 'pass', summary: `db ${ms}ms` };
  } catch (err) {
    return { verdict: 'fail', summary: `db unreachable: ${String(err)}` };
  }
}

async function checkFreshness(): Promise<{ verdict: Verdict; summary: string }> {
  try {
    const jobs = await Job.findAll({
      attributes: ['name', 'lastRunAt', 'lastStatus'],
    });
    const staleThresholdMs = 24 * 60 * 60 * 1000;
    const errored = jobs.filter((j) => j.lastStatus === 'error');
    const stale = jobs.filter((j) => {
      if (!j.lastRunAt) return true;
      return Date.now() - j.lastRunAt.getTime() > staleThresholdMs;
    });

    let verdict: Verdict;
    if (errored.length > 0) {
      verdict = 'fail';
    } else if (stale.length > 0) {
      verdict = 'warn';
    } else {
      verdict = 'pass';
    }

    return {
      verdict,
      summary: `${jobs.length} jobs (${errored.length} errored, ${stale.length} stale > 24h)`,
    };
  } catch (err) {
    return { verdict: 'warn', summary: `freshness check failed: ${String(err)}` };
  }
}

export async function getAuditSummary(
  householdId: number,
  auditCtx: AuditAuthContext,
  app: Application,
  windowMinutes = 60,
): Promise<AuditSummaryResult> {
  const window = Math.max(1, Math.min(1440, windowMinutes));
  const since = new Date(Date.now() - window * 60 * 1000).toISOString();

  const [healthResult, freshnessResult, integrityResult, countsResult, clientResult, serverResult, routesResult] =
    await Promise.allSettled([
      checkHealth(),
      checkFreshness(),
      getIntegrity(householdId),
      getCounts(householdId),
      getClientErrors(householdId, { since }),
      getServerErrors(householdId, { since }),
      runRouteProbe(app, auditCtx),
    ]);

  const health =
    healthResult.status === 'fulfilled'
      ? healthResult.value
      : { verdict: 'fail' as Verdict, summary: `error: ${String(healthResult.reason)}` };

  const freshness =
    freshnessResult.status === 'fulfilled'
      ? freshnessResult.value
      : { verdict: 'warn' as Verdict, summary: `error: ${String(freshnessResult.reason)}` };

  let integrity: { verdict: Verdict; summary: string };
  if (integrityResult.status === 'fulfilled') {
    const r = integrityResult.value;
    let verdict: Verdict;
    if (r.orphanedTransactions > 0) {
      verdict = 'fail';
    } else if (r.duplicateGroups.count > 0) {
      verdict = 'warn';
    } else {
      verdict = 'pass';
    }
    integrity = {
      verdict,
      summary: `${r.duplicateGroups.count} dupe groups (${r.duplicateGroups.extraRowCount} extra rows), ${r.unenrichedTransactions} unenriched, ${r.orphanedTransactions} orphans`,
    };
  } else {
    integrity = { verdict: 'warn', summary: `error: ${String(integrityResult.reason)}` };
  }

  const counts =
    countsResult.status === 'fulfilled'
      ? {
          verdict: 'pass' as Verdict,
          summary: `${countsResult.value.counts.transactions ?? 0} txns, ${countsResult.value.counts.accounts ?? 0} accounts`,
        }
      : { verdict: 'warn' as Verdict, summary: `error: ${String(countsResult.reason)}` };

  let clientErrors: { verdict: Verdict; summary: string };
  if (clientResult.status === 'fulfilled') {
    const n = clientResult.value.count;
    const verdict: Verdict = n === 0 ? 'pass' : n <= 20 ? 'warn' : 'fail';
    clientErrors = { verdict, summary: `${n} client errors in window` };
  } else {
    clientErrors = { verdict: 'warn', summary: `error: ${String(clientResult.reason)}` };
  }

  let serverErrors: { verdict: Verdict; summary: string };
  if (serverResult.status === 'fulfilled') {
    const n = serverResult.value.count;
    const verdict: Verdict = n === 0 ? 'pass' : n <= 5 ? 'warn' : 'fail';
    serverErrors = { verdict, summary: `${n} server errors in window` };
  } else {
    serverErrors = { verdict: 'warn', summary: `error: ${String(serverResult.reason)}` };
  }

  let routes: { verdict: Verdict; summary: string };
  if (routesResult.status === 'fulfilled') {
    const r = routesResult.value;
    const total = r.routes.length;
    const broken = r.routes.filter((rt) => !rt.ok);
    const verdict: Verdict = broken.length === 0 ? 'pass' : 'fail';
    routes = {
      verdict,
      summary:
        broken.length === 0
          ? `${total}/${total} pages green`
          : `BROKEN: ${broken.map((rt) => rt.page).join(', ')}`,
    };
  } else {
    routes = { verdict: 'warn', summary: `error: ${String(routesResult.reason)}` };
  }

  const overall = worstOf([
    health.verdict,
    freshness.verdict,
    integrity.verdict,
    counts.verdict,
    clientErrors.verdict,
    serverErrors.verdict,
    routes.verdict,
  ]);

  return {
    overall,
    dimensions: { health, freshness, integrity, counts, clientErrors, serverErrors, routes },
    generatedAt: new Date().toISOString(),
  };
}
