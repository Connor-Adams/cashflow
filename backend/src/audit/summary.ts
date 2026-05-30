import type { Express } from 'express';
import { healthDeep } from './healthDeep';
import { freshness } from './freshness';
import { integrity } from './integrity';
import { counts } from './counts';
import { clientErrors } from './clientErrors';
import { serverErrors } from './serverErrors';
import { routeProbe } from './routeProbe';
import type { AuditAuthContext } from '../auth/auditAuth';

type Verdict = 'pass' | 'warn' | 'fail';
const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
const worst = (vs: Verdict[]): Verdict =>
  vs.reduce((acc, v) => (rank[v] > rank[acc] ? v : acc), 'pass' as Verdict);

export interface AuditSummary {
  overall: Verdict;
  dimensions: Record<string, { verdict: Verdict; summary: string }>;
  generatedAt: string;
}

export async function summary(
  app: Express,
  audit: AuditAuthContext,
  windowMinutes = 60,
): Promise<AuditSummary> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const [h, f, i, c, ce, se, rp] = await Promise.all([
    healthDeep(),
    freshness(audit.household.id),
    integrity(audit.household.id),
    counts(audit.household.id),
    clientErrors(audit.household.id, { since, limit: 500 }),
    serverErrors(audit.household.id, { since, limit: 500 }),
    routeProbe(app, audit),
  ]);

  const dims: AuditSummary['dimensions'] = {
    health: {
      verdict: h.ok ? 'pass' : 'fail',
      summary: h.db.reachable
        ? `db ${h.db.latencyMs}ms; ${h.migrations.pending} pending migrations`
        : `db unreachable: ${h.db.error}`,
    },
    freshness: (() => {
      const erroredJobs = f.jobs.filter((j) => j.lastStatus === 'error');
      const stale = f.jobs.filter(
        (j) => j.secondsSinceLastRun != null && j.secondsSinceLastRun > 86_400,
      );
      const verdict: Verdict =
        erroredJobs.length > 0 ? 'fail' : stale.length > 0 ? 'warn' : 'pass';
      return {
        verdict,
        summary: `${f.jobs.length} jobs (${erroredJobs.length} errored, ${stale.length} stale > 24h)`,
      };
    })(),
    integrity: (() => {
      const verdict: Verdict =
        i.orphanedTransactions > 0
          ? 'fail'
          : i.duplicateGroups.count > 0
            ? 'warn'
            : 'pass';
      return {
        verdict,
        summary: `${i.duplicateGroups.count} dupe groups (${i.duplicateGroups.extraRowCount} extras), ${i.unenrichedTransactions} unenriched, ${i.orphanedTransactions} orphans`,
      };
    })(),
    counts: {
      verdict: 'pass' as Verdict,
      summary: Object.entries(c.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
    },
    clientErrors: {
      verdict:
        ce.count === 0 ? 'pass' : ce.count > 20 ? 'fail' : ('warn' as Verdict),
      summary: `${ce.count} client errors in last ${windowMinutes}m`,
    },
    serverErrors: {
      verdict:
        se.count === 0 ? 'pass' : se.count > 5 ? 'fail' : ('warn' as Verdict),
      summary: `${se.count} server 5xx in last ${windowMinutes}m`,
    },
    routes: (() => {
      const broken = rp.routes.filter((r) => !r.ok);
      return {
        verdict: (broken.length === 0 ? 'pass' : 'fail') as Verdict,
        summary:
          broken.length === 0
            ? `${rp.routes.length}/${rp.routes.length} pages green`
            : `BROKEN: ${broken.map((b) => b.page).join(', ')}`,
      };
    })(),
  };

  const overall = worst(Object.values(dims).map((d) => d.verdict));
  return { overall, dimensions: dims, generatedAt: new Date().toISOString() };
}
