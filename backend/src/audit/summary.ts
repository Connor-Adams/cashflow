import { runHealthDeep } from './healthDeep';
import { runFreshness } from './freshness';
import { runCounts } from './counts';
import { runIntegrity } from './integrity';
import { runClientErrors } from './clientErrors';
import { runServerErrors } from './serverErrors';
import { runRouteProbe } from './routeProbe';
import type { Application } from 'express';

type Verdict = 'pass' | 'warn' | 'fail';

export type SummaryResult = {
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
};

function worst(...verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

export async function runSummary(
  userId: number,
  householdId: number,
  app: Application,
  opts: { windowMinutes?: number }
): Promise<SummaryResult> {
  const windowMinutes = Math.min(1440, Math.max(1, opts.windowMinutes ?? 60));
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const [health, freshness, counts, integrity, clientErrors, serverErrors, routes] =
    await Promise.all([
      runHealthDeep(),
      runFreshness(householdId),
      runCounts(householdId),
      runIntegrity(householdId),
      runClientErrors(householdId, { since }),
      runServerErrors(householdId, { since }),
      runRouteProbe(userId, app),
    ]);

  // health
  const healthVerdict: Verdict =
    health.db.reachable && health.migrations.pending === 0 ? 'pass' : 'fail';
  const healthSummary =
    health.db.reachable
      ? `db ${health.db.latencyMs}ms; ${health.migrations.pending} pending migration(s)`
      : `db unreachable: ${health.db.error ?? 'unknown error'}`;

  // freshness — errored job → fail, stale job (no errors) → warn, else pass
  const erroredJobs = freshness.jobs.filter((j) => j.lastStatus === 'error');
  const staleJobs = freshness.jobs.filter(
    (j) => j.secondsSinceLastRun !== null && j.secondsSinceLastRun > 24 * 3600
  );
  const freshnessVerdict: Verdict =
    erroredJobs.length > 0 ? 'fail' : staleJobs.length > 0 ? 'warn' : 'pass';
  const freshnessJobs = freshness.jobs.length;
  const freshnessSummary =
    erroredJobs.length > 0
      ? `${freshnessJobs} job(s) (${erroredJobs.length} errored, ${staleJobs.length} stale > 24h)`
      : staleJobs.length > 0
      ? `${freshnessJobs} job(s) (0 errored, ${staleJobs.length} stale > 24h)`
      : `${freshnessJobs} job(s) all healthy`;

  // integrity — orphans → fail, dupes → warn, else pass
  const integrityVerdict: Verdict =
    integrity.orphanedTransactions > 0
      ? 'fail'
      : integrity.duplicateGroups.count > 0
      ? 'warn'
      : 'pass';
  const integritySummary =
    integrity.orphanedTransactions > 0
      ? `${integrity.orphanedTransactions} orphaned transaction(s)`
      : integrity.duplicateGroups.count > 0
      ? `${integrity.duplicateGroups.count} duplicate group(s) (${integrity.duplicateGroups.extraRowCount} extra row(s))`
      : `0 duplicates, 0 orphans, ${integrity.unenrichedTransactions} unenriched`;

  // counts — always pass (informational)
  const totalRows = Object.values(counts.counts).reduce((a, b) => a + b, 0);
  const countsSummary = `${totalRows} total rows across ${Object.keys(counts.counts).length} tables`;

  // clientErrors
  const clientCount = clientErrors.count;
  const clientVerdict: Verdict =
    clientCount === 0 ? 'pass' : clientCount <= 20 ? 'warn' : 'fail';
  const clientSummary = `${clientCount} client error(s) in last ${windowMinutes}min`;

  // serverErrors
  const serverCount = serverErrors.count;
  const serverVerdict: Verdict =
    serverCount === 0 ? 'pass' : serverCount <= 5 ? 'warn' : 'fail';
  const serverSummary = `${serverCount} server error(s) in last ${windowMinutes}min`;

  // routes
  const totalRoutes = routes.routes.length;
  const brokenRoutes = routes.routes.filter((r) => !r.ok);
  const routesVerdict: Verdict = brokenRoutes.length > 0 ? 'fail' : 'pass';
  const routesSummary =
    brokenRoutes.length > 0
      ? `BROKEN: ${brokenRoutes.map((r) => r.page).join(', ')}`
      : `${totalRoutes}/${totalRoutes} pages green`;

  const overall = worst(
    healthVerdict,
    freshnessVerdict,
    integrityVerdict,
    'pass', // counts always pass
    clientVerdict,
    serverVerdict,
    routesVerdict
  );

  return {
    overall,
    dimensions: {
      health: { verdict: healthVerdict, summary: healthSummary },
      freshness: { verdict: freshnessVerdict, summary: freshnessSummary },
      integrity: { verdict: integrityVerdict, summary: integritySummary },
      counts: { verdict: 'pass', summary: countsSummary },
      clientErrors: { verdict: clientVerdict, summary: clientSummary },
      serverErrors: { verdict: serverVerdict, summary: serverSummary },
      routes: { verdict: routesVerdict, summary: routesSummary },
    },
    generatedAt: new Date().toISOString(),
  };
}
