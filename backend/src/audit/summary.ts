import { healthDeep } from './healthDeep';
import { freshness } from './freshness';
import { integrity } from './integrity';
import { counts } from './counts';
import { queryClientErrors } from './clientErrors';
import { queryServerErrors } from './serverErrors';

type Verdict = 'pass' | 'warn' | 'fail';

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

function worstOf(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('warn')) return 'warn';
  return 'pass';
}

export async function buildSummary(householdId: number): Promise<SummaryResult> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [healthResult, freshnessResult, integrityResult, countsResult, clientResult, serverResult] =
    await Promise.all([
      healthDeep().catch((e) => ({ error: String(e) })),
      freshness(householdId).catch((e) => ({ error: String(e) })),
      integrity(householdId).catch((e) => ({ error: String(e) })),
      counts(householdId).catch((e) => ({ error: String(e) })),
      queryClientErrors({ householdId, since: since24h, limit: 100 }).catch((e) => ({ error: String(e) })),
      queryServerErrors({ householdId, since: since24h, limit: 100 }).catch((e) => ({ error: String(e) })),
    ]);

  // Health dimension
  let healthVerdict: Verdict = 'fail';
  let healthSummary = 'Unknown';
  if ('error' in healthResult) {
    healthVerdict = 'fail';
    healthSummary = `Probe error: ${healthResult.error}`;
  } else {
    const h = healthResult as Awaited<ReturnType<typeof healthDeep>>;
    if (h.db.reachable && h.migrations.pending === 0) {
      healthVerdict = 'pass';
      healthSummary = `DB reachable (${h.db.latencyMs}ms), no pending migrations`;
    } else {
      healthVerdict = 'fail';
      const reasons: string[] = [];
      if (!h.db.reachable) reasons.push('DB unreachable');
      if (h.migrations.pending > 0) reasons.push(`${h.migrations.pending} pending migrations`);
      healthSummary = reasons.join(', ');
    }
  }

  // Freshness dimension
  let freshnessVerdict: Verdict = 'pass';
  let freshnessSummary = 'All jobs healthy';
  if ('error' in freshnessResult) {
    freshnessVerdict = 'fail';
    freshnessSummary = `Probe error: ${freshnessResult.error}`;
  } else {
    const f = freshnessResult as Awaited<ReturnType<typeof freshness>>;
    const errored = f.jobs.filter((j) => j.lastStatus === 'error');
    const stale = f.jobs.filter(
      (j) => j.secondsSinceLastRun != null && j.secondsSinceLastRun > 24 * 3600,
    );
    if (errored.length > 0) {
      freshnessVerdict = 'fail';
      freshnessSummary = `${errored.length} errored job(s): ${errored.map((j) => j.name).join(', ')}`;
    } else if (stale.length > 0) {
      freshnessVerdict = 'warn';
      freshnessSummary = `${stale.length} stale job(s) (>24h): ${stale.map((j) => j.name).join(', ')}`;
    } else {
      freshnessVerdict = 'pass';
      freshnessSummary = `${f.jobs.length} job(s) healthy`;
    }
  }

  // Integrity dimension
  let integrityVerdict: Verdict = 'pass';
  let integritySummary = 'No integrity issues';
  if ('error' in integrityResult) {
    integrityVerdict = 'fail';
    integritySummary = `Probe error: ${integrityResult.error}`;
  } else {
    const i = integrityResult as Awaited<ReturnType<typeof integrity>>;
    if (i.orphanedTransactions > 0) {
      integrityVerdict = 'fail';
      integritySummary = `${i.orphanedTransactions} orphaned transactions`;
    } else if (i.duplicateGroups.count > 0) {
      integrityVerdict = 'warn';
      integritySummary = `${i.duplicateGroups.count} duplicate group(s) (${i.duplicateGroups.extraRowCount} extra rows)`;
    } else {
      integrityVerdict = 'pass';
      integritySummary = `No orphans, ${i.unenrichedTransactions} unenriched transactions`;
    }
  }

  // Counts dimension (always pass — informational)
  let countsVerdict: Verdict = 'pass';
  let countsSummary = 'Counts collected';
  if ('error' in countsResult) {
    countsVerdict = 'warn';
    countsSummary = `Probe error: ${countsResult.error}`;
  } else {
    const c = (countsResult as Awaited<ReturnType<typeof counts>>).counts;
    countsSummary = `${c.transactions} txns, ${c.accounts} accounts, ${c.subscriptions} subscriptions`;
  }

  // Client errors dimension
  let clientVerdict: Verdict = 'pass';
  let clientSummary = 'No client errors in 24h';
  if ('error' in clientResult) {
    clientVerdict = 'warn';
    clientSummary = `Probe error: ${clientResult.error}`;
  } else {
    const ce = clientResult as Awaited<ReturnType<typeof queryClientErrors>>;
    if (ce.count === 0) {
      clientVerdict = 'pass';
      clientSummary = 'No client errors in 24h';
    } else if (ce.count <= 20) {
      clientVerdict = 'warn';
      clientSummary = `${ce.count} client error(s) in 24h`;
    } else {
      clientVerdict = 'fail';
      clientSummary = `${ce.count} client errors in 24h (>${20})`;
    }
  }

  // Server errors dimension
  let serverVerdict: Verdict = 'pass';
  let serverSummary = 'No server errors in 24h';
  if ('error' in serverResult) {
    serverVerdict = 'warn';
    serverSummary = `Probe error: ${serverResult.error}`;
  } else {
    const se = serverResult as Awaited<ReturnType<typeof queryServerErrors>>;
    if (se.count === 0) {
      serverVerdict = 'pass';
      serverSummary = 'No server errors in 24h';
    } else if (se.count <= 5) {
      serverVerdict = 'warn';
      serverSummary = `${se.count} server error(s) in 24h`;
    } else {
      serverVerdict = 'fail';
      serverSummary = `${se.count} server errors in 24h (>${5})`;
    }
  }

  // Routes dimension — not probed in summary (requires HTTP round-trip); always pass here
  const routesVerdict: Verdict = 'pass';
  const routesSummary = 'Use /api/audit/route-probe for per-page check';

  const overall = worstOf([
    healthVerdict,
    freshnessVerdict,
    integrityVerdict,
    countsVerdict,
    clientVerdict,
    serverVerdict,
    routesVerdict,
  ]);

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
