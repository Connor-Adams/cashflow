import type { Express } from 'express';
import { buildHealthDeep } from './healthDeep';
import { buildFreshness } from './freshness';
import { buildIntegrity } from './integrity';
import { buildCounts } from './counts';
import { buildClientErrors } from './clientErrors';
import { buildServerErrors } from './serverErrors';
import { buildRouteProbe } from './routeProbe';

type Verdict = 'pass' | 'warn' | 'fail';

function worstOf(...verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

export async function buildSummary(
  app: Express,
  householdId: number,
  userId: number,
  windowMinutes: number,
) {
  const window = Math.max(1, Math.min(1440, windowMinutes));
  const since = new Date(Date.now() - window * 60 * 1000);

  const [health, freshness, integrity, counts, clientErrs, serverErrs, routes] =
    await Promise.all([
      buildHealthDeep(),
      buildFreshness(householdId),
      buildIntegrity(householdId),
      buildCounts(householdId),
      buildClientErrors(householdId, { since, limit: 500 }),
      buildServerErrors(householdId, { since, limit: 500 }),
      buildRouteProbe(app, userId),
    ]);

  // --- health ---
  const healthVerdict: Verdict = health.ok ? 'pass' : 'fail';
  const healthSummary = health.ok
    ? `db ${health.db.latencyMs}ms; ${health.migrations.pending} pending migrations`
    : health.db.reachable
      ? `${health.migrations.pending} pending migrations`
      : `DB unreachable: ${health.db.error ?? 'unknown'}`;

  // --- freshness ---
  const jobs = freshness.jobs;
  const staleCutoffSec = 24 * 60 * 60;
  const erroredJobs = jobs.filter((j) => j.lastStatus === 'error');
  const staleJobs = jobs.filter(
    (j) => j.secondsSinceLastRun !== null && j.secondsSinceLastRun > staleCutoffSec,
  );
  let freshnessVerdict: Verdict;
  if (erroredJobs.length > 0) {
    freshnessVerdict = 'fail';
  } else if (staleJobs.length > 0) {
    freshnessVerdict = 'warn';
  } else {
    freshnessVerdict = 'pass';
  }
  const freshnessSummary = `${jobs.length} jobs (${erroredJobs.length} errored, ${staleJobs.length} stale >24h)`;

  // --- integrity ---
  let integrityVerdict: Verdict;
  if (integrity.orphanedTransactions > 0) {
    integrityVerdict = 'fail';
  } else if (integrity.duplicateGroups.count > 0) {
    integrityVerdict = 'warn';
  } else {
    integrityVerdict = 'pass';
  }
  const integritySummary = integrity.orphanedTransactions > 0
    ? `ORPHANS: ${integrity.orphanedTransactions} transactions with no account`
    : integrity.duplicateGroups.count > 0
      ? `${integrity.duplicateGroups.count} duplicate groups (${integrity.duplicateGroups.extraRowCount} extra rows)`
      : `0 duplicates, 0 orphans`;

  // --- counts (always pass — informational) ---
  const countsVerdict: Verdict = 'pass';
  const totalCounts = Object.values(counts.counts as Record<string, number>).reduce(
    (s, v) => s + v,
    0,
  );
  const countsSummary = `${Object.keys(counts.counts as Record<string, number>).length} models tracked; ${totalCounts} total rows`;

  // --- client errors ---
  const cCount = clientErrs.count;
  const clientVerdict: Verdict = cCount === 0 ? 'pass' : cCount <= 20 ? 'warn' : 'fail';
  const clientSummary = `${cCount} client errors in last ${window}m`;

  // --- server errors ---
  const sCount = serverErrs.count;
  const serverVerdict: Verdict = sCount === 0 ? 'pass' : sCount <= 5 ? 'warn' : 'fail';
  const serverSummary = `${sCount} server errors in last ${window}m`;

  // --- routes ---
  const brokenPages = routes.routes.filter((r) => !r.ok).map((r) => r.page);
  const routesVerdict: Verdict = brokenPages.length === 0 ? 'pass' : 'fail';
  const routesSummary =
    brokenPages.length === 0
      ? `${routes.routes.length}/${routes.routes.length} pages green`
      : `BROKEN: ${brokenPages.join(', ')}`;

  const overall = worstOf(
    healthVerdict,
    freshnessVerdict,
    integrityVerdict,
    countsVerdict,
    clientVerdict,
    serverVerdict,
    routesVerdict,
  );

  return {
    overall,
    dimensions: {
      health: { verdict: healthVerdict, summary: healthSummary },
      freshness: { verdict: freshnessVerdict, summary: freshnessSummary },
      integrity: { verdict: integrityVerdict, summary: integritySummary },
      counts: { verdict: countsVerdict, summary: countsSummary },
      clientErrors: { verdict: clientVerdict, summary: clientSummary },
      serverErrors: { verdict: serverVerdict, summary: serverSummary },
      routes: { verdict: routesVerdict, summary: routesSummary },
    },
    generatedAt: new Date().toISOString(),
  };
}
