import { buildHealthDeep } from './healthDeep';
import { buildFreshness } from './freshness';
import { buildIntegrity } from './integrity';
import { buildCounts } from './counts';
import { buildClientErrors } from './clientErrors';
import { buildServerErrors } from './serverErrors';
import { buildRouteProbe } from './routeProbe';
import type { User } from '../models/User';
import type { Household } from '../models/Household';

export type Verdict = 'pass' | 'warn' | 'fail';

export type DimensionResult = { verdict: Verdict; summary: string };

export type AuditSummaryResult = {
  overall: Verdict;
  dimensions: {
    health: DimensionResult;
    freshness: DimensionResult;
    integrity: DimensionResult;
    counts: DimensionResult;
    clientErrors: DimensionResult;
    serverErrors: DimensionResult;
    routes: DimensionResult;
  };
  generatedAt: string;
};

function worstOf(...verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

const STALE_THRESHOLD_SECONDS = 24 * 60 * 60;

export async function buildAuditSummary(
  user: User,
  household: Household,
  localPort: number,
  windowMinutes: number,
): Promise<AuditSummaryResult> {
  const householdId = household.id;
  const windowSince = new Date(Date.now() - windowMinutes * 60 * 1000);

  const [health, freshness, integrity, counts, clientErrors, serverErrors, routes] =
    await Promise.all([
      buildHealthDeep(),
      buildFreshness(householdId),
      buildIntegrity(householdId),
      buildCounts(householdId),
      buildClientErrors(householdId, { since: windowSince.toISOString(), limit: 500 }),
      buildServerErrors(householdId, { since: windowSince.toISOString(), limit: 500 }),
      buildRouteProbe(user, localPort),
    ]);

  // ── Health ──────────────────────────────────────────────────────────────
  const healthVerdict: Verdict = health.ok ? 'pass' : 'fail';
  const healthSummary = health.ok
    ? `db ${health.db.latencyMs}ms; ${health.migrations.pending} pending migrations`
    : `db ${health.db.reachable ? 'ok' : 'UNREACHABLE'}; ${health.migrations.pending} pending migrations`;

  // ── Freshness ───────────────────────────────────────────────────────────
  const erroredJobs = freshness.jobs.filter((j) => j.lastStatus === 'error');
  const staleJobs = freshness.jobs.filter(
    (j) => j.secondsSinceLastRun !== null && j.secondsSinceLastRun > STALE_THRESHOLD_SECONDS,
  );
  let freshnessVerdict: Verdict = 'pass';
  if (erroredJobs.length > 0) freshnessVerdict = 'fail';
  else if (staleJobs.length > 0) freshnessVerdict = 'warn';
  const freshnessSummary = `${freshness.jobs.length} jobs (${erroredJobs.length} errored, ${staleJobs.length} stale >24h)`;

  // ── Integrity ───────────────────────────────────────────────────────────
  let integrityVerdict: Verdict = 'pass';
  if (integrity.orphanedTransactions > 0) integrityVerdict = 'fail';
  else if (integrity.duplicateGroups.count > 0) integrityVerdict = 'warn';
  const integritySummary = `${integrity.duplicateGroups.count} dupe groups; ${integrity.orphanedTransactions} orphans; ${integrity.unenrichedTransactions} unenriched`;

  // ── Counts ──────────────────────────────────────────────────────────────
  const countsSummary = `${counts.transactions} txns; ${counts.accounts} accounts; ${counts.rules} rules`;

  // ── Client errors ────────────────────────────────────────────────────────
  let clientErrorsVerdict: Verdict = 'pass';
  if (clientErrors.count > 20) clientErrorsVerdict = 'fail';
  else if (clientErrors.count > 0) clientErrorsVerdict = 'warn';
  const clientErrorsSummary = `${clientErrors.count} client errors in window`;

  // ── Server errors ────────────────────────────────────────────────────────
  let serverErrorsVerdict: Verdict = 'pass';
  if (serverErrors.count > 5) serverErrorsVerdict = 'fail';
  else if (serverErrors.count > 0) serverErrorsVerdict = 'warn';
  const serverErrorsSummary = `${serverErrors.count} server errors in window`;

  // ── Routes ───────────────────────────────────────────────────────────────
  const brokenRoutes = routes.routes.filter((r) => !r.ok).map((r) => r.page);
  const routesVerdict: Verdict = brokenRoutes.length > 0 ? 'fail' : 'pass';
  const totalRoutes = routes.routes.length;
  const routesSummary =
    brokenRoutes.length === 0
      ? `${totalRoutes}/${totalRoutes} pages green`
      : `BROKEN: ${brokenRoutes.join(', ')}`;

  const overall = worstOf(
    healthVerdict, freshnessVerdict, integrityVerdict,
    'pass', // counts always pass
    clientErrorsVerdict, serverErrorsVerdict, routesVerdict,
  );

  return {
    overall,
    dimensions: {
      health: { verdict: healthVerdict, summary: healthSummary },
      freshness: { verdict: freshnessVerdict, summary: freshnessSummary },
      integrity: { verdict: integrityVerdict, summary: integritySummary },
      counts: { verdict: 'pass', summary: countsSummary },
      clientErrors: { verdict: clientErrorsVerdict, summary: clientErrorsSummary },
      serverErrors: { verdict: serverErrorsVerdict, summary: serverErrorsSummary },
      routes: { verdict: routesVerdict, summary: routesSummary },
    },
    generatedAt: new Date().toISOString(),
  };
}
