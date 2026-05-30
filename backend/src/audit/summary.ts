import { healthDeep } from './healthDeep';
import { freshness } from './freshness';
import { integrity } from './integrity';
import { counts } from './counts';
import { clientErrors } from './clientErrors';
import { serverErrors } from './serverErrors';
import { routeProbe } from './routeProbe';

type Verdict = 'pass' | 'warn' | 'fail';

function worstOf(...verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

function verdictHealth(result: Awaited<ReturnType<typeof healthDeep>>): {
  verdict: Verdict;
  summary: string;
} {
  if (result.ok) {
    return {
      verdict: 'pass',
      summary: `db ${result.db.latencyMs}ms; 0 pending migrations`,
    };
  }
  const parts: string[] = [];
  if (!result.db.reachable) parts.push(`db unreachable: ${result.db.error ?? 'unknown'}`);
  if (result.migrations.pending > 0) {
    parts.push(`${result.migrations.pending} pending migrations`);
  }
  return { verdict: 'fail', summary: parts.join('; ') };
}

function verdictFreshness(result: Awaited<ReturnType<typeof freshness>>): {
  verdict: Verdict;
  summary: string;
} {
  const erroredJobs = result.jobs.filter((j) => j.lastStatus === 'error');
  const staleJobs = result.jobs.filter(
    (j) => j.secondsSinceLastRun !== null && j.secondsSinceLastRun > 24 * 3600
  );

  if (erroredJobs.length > 0) {
    return {
      verdict: 'fail',
      summary: `${result.jobs.length} jobs (${erroredJobs.length} errored, ${staleJobs.length} stale > 24h)`,
    };
  }
  if (staleJobs.length > 0) {
    return {
      verdict: 'warn',
      summary: `${result.jobs.length} jobs (0 errored, ${staleJobs.length} stale > 24h)`,
    };
  }
  return {
    verdict: 'pass',
    summary: `${result.jobs.length} jobs (0 errored, 0 stale > 24h)`,
  };
}

function verdictIntegrity(result: Awaited<ReturnType<typeof integrity>>): {
  verdict: Verdict;
  summary: string;
} {
  const { duplicateGroups, orphanedTransactions } = result;
  if (orphanedTransactions > 0) {
    return {
      verdict: 'fail',
      summary: `${orphanedTransactions} orphaned tx, ${duplicateGroups.count} dupe groups`,
    };
  }
  if (duplicateGroups.count > 0) {
    return {
      verdict: 'warn',
      summary: `0 orphaned tx, ${duplicateGroups.count} dupe groups`,
    };
  }
  return { verdict: 'pass', summary: '0 orphans, 0 dupe groups' };
}

function verdictCounts(result: Awaited<ReturnType<typeof counts>>): {
  verdict: Verdict;
  summary: string;
} {
  const total = Object.values(result).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  return { verdict: 'pass', summary: `${total} total rows across models (informational)` };
}

function verdictClientErrors(count: number): { verdict: Verdict; summary: string } {
  if (count === 0) return { verdict: 'pass', summary: '0 client errors in window' };
  if (count <= 20) return { verdict: 'warn', summary: `${count} client errors in window` };
  return { verdict: 'fail', summary: `${count} client errors in window` };
}

function verdictServerErrors(count: number): { verdict: Verdict; summary: string } {
  if (count === 0) return { verdict: 'pass', summary: '0 server errors in window' };
  if (count <= 5) return { verdict: 'warn', summary: `${count} server errors in window` };
  return { verdict: 'fail', summary: `${count} server errors in window` };
}

function verdictRoutes(result: Awaited<ReturnType<typeof routeProbe>>): {
  verdict: Verdict;
  summary: string;
} {
  const total = result.routes.length;
  const broken = result.routes.filter((r) => !r.ok);
  if (broken.length === 0) {
    return { verdict: 'pass', summary: `${total}/${total} pages green` };
  }
  return {
    verdict: 'fail',
    summary: `BROKEN: ${broken.map((r) => r.page).join(', ')}`,
  };
}

export interface SummaryResult {
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

export async function summary(
  householdId: number,
  userId: number,
  windowMinutes: number = 60
): Promise<SummaryResult> {
  const clamped = Math.min(Math.max(Math.floor(windowMinutes), 1), 1440);
  const since = new Date(Date.now() - clamped * 60 * 1000).toISOString();

  const [
    healthResult,
    freshnessResult,
    integrityResult,
    countsResult,
    clientErrorsResult,
    serverErrorsResult,
    routeProbeResult,
  ] = await Promise.all([
    healthDeep(),
    freshness(householdId),
    integrity(householdId),
    counts(householdId),
    clientErrors(householdId, { since }),
    serverErrors(householdId, { since }),
    routeProbe(userId),
  ]);

  const dimensions = {
    health: verdictHealth(healthResult),
    freshness: verdictFreshness(freshnessResult),
    integrity: verdictIntegrity(integrityResult),
    counts: verdictCounts(countsResult),
    clientErrors: verdictClientErrors(clientErrorsResult.count),
    serverErrors: verdictServerErrors(serverErrorsResult.count),
    routes: verdictRoutes(routeProbeResult),
  };

  const overall = worstOf(...Object.values(dimensions).map((d) => d.verdict));

  return { overall, dimensions, generatedAt: new Date().toISOString() };
}
