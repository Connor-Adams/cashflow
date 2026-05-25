#!/usr/bin/env tsx
/**
 * Backfill `security_id` on InvestmentActivity rows imported by the
 * activities-export CLI (`importWsActivitiesExport.ts`).
 *
 * The CLI inserts rows with `security_id = NULL` because the per-row
 * parser already resolves the security symbol from the CSV's structured
 * `symbol` column and synthesizes a description like:
 *
 *   "VFV Vanguard Investments Canada Inc.: Bought 0.4076 shares at ..."
 *   "DOT Polkadot: Staking reward 0.0005009278"
 *   "BTC Bitcoin: Security transfer"
 *   "Correction (ANOMALY): ETH Ethereum 0.029102"
 *   "Interest" / "Fee"  (no symbol — skip)
 *
 * This script parses the symbol back out of the description and joins
 * against the `securities` table (matching householdId or NULL household
 * fallback) to populate `security_id`. Without this backfill the
 * fuzzy-match dedup on future re-imports cannot find these rows
 * (the matcher joins on security.symbol).
 *
 * Dry-run by default; pass --commit to write.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfillWsActivitiesExportSecurityId.ts
 *   DATABASE_URL=... npx tsx scripts/backfillWsActivitiesExportSecurityId.ts --commit
 */
import { Op } from 'sequelize';
import { InvestmentActivity, Security, sequelize } from '../src/models';

type Outcome =
  | { kind: 'no-symbol' }
  | { kind: 'no-match'; symbol: string }
  | { kind: 'multi-match'; symbol: string; candidateIds: number[] }
  | { kind: 'matched'; symbol: string; securityId: number };

const LEADING_SYM_RE = /^([A-Z0-9.]{1,8})\s/;
const ANY_UPPERCASE_RE = /\b([A-Z0-9.]{2,8})\b/g;

const NOT_SYMBOL = new Set([
  'BUY',
  'SELL',
  'CAD',
  'USD',
  'FX',
  'INC',
  'ETF',
  'INDEX',
  'CORP',
  'LTD',
  'LP',
  'ANOMALY',
  'LONG',
  'SHORT',
]);

function extractSymbolCandidates(description: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const leading = description.match(LEADING_SYM_RE);
  if (leading && !NOT_SYMBOL.has(leading[1])) {
    out.push(leading[1]);
    seen.add(leading[1]);
  }
  let m: RegExpExecArray | null;
  ANY_UPPERCASE_RE.lastIndex = 0;
  while ((m = ANY_UPPERCASE_RE.exec(description)) != null) {
    const t = m[1];
    if (NOT_SYMBOL.has(t) || seen.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function resolveSymbol(
  symbol: string,
  householdId: number | null,
): Promise<Security[]> {
  const where: Record<string, unknown> = { symbol };
  // Prefer same-household; fall back to NULL household
  const candidates = await Security.findAll({
    where: {
      ...where,
      [Op.or]: [
        { householdId: householdId },
        { householdId: null },
      ],
    },
  });
  const sameHousehold = candidates.filter((c) => c.householdId === householdId);
  if (sameHousehold.length > 0) return sameHousehold;
  return candidates;
}

async function classify(activity: InvestmentActivity): Promise<Outcome> {
  const candidates = extractSymbolCandidates(activity.description);
  if (candidates.length === 0) return { kind: 'no-symbol' };

  for (const symbol of candidates) {
    const securities = await resolveSymbol(symbol, activity.householdId);
    if (securities.length === 0) continue;
    if (securities.length === 1) {
      return { kind: 'matched', symbol, securityId: securities[0]!.id };
    }
    return {
      kind: 'multi-match',
      symbol,
      candidateIds: securities.map((s) => s.id),
    };
  }
  return { kind: 'no-match', symbol: candidates[0]! };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  const rows = await InvestmentActivity.findAll({
    where: {
      importBatch: { [Op.like]: 'ws-activities-export-%' },
      securityId: null,
    },
  });

  console.log(`Mode: ${commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`Candidate rows: ${rows.length}`);

  const counts = { matched: 0, 'no-symbol': 0, 'no-match': 0, 'multi-match': 0 };
  const matches: { id: number; securityId: number }[] = [];
  const noMatch: { id: number; description: string; symbol: string }[] = [];
  const multiMatch: { id: number; description: string; symbol: string; candidateIds: number[] }[] = [];

  for (const row of rows) {
    const outcome = await classify(row);
    counts[outcome.kind] += 1;
    if (outcome.kind === 'matched') {
      matches.push({ id: row.id, securityId: outcome.securityId });
    } else if (outcome.kind === 'no-match') {
      noMatch.push({ id: row.id, description: row.description, symbol: outcome.symbol });
    } else if (outcome.kind === 'multi-match') {
      multiMatch.push({
        id: row.id,
        description: row.description,
        symbol: outcome.symbol,
        candidateIds: outcome.candidateIds,
      });
    }
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(counts, null, 2));

  if (noMatch.length > 0) {
    console.log('\n=== No security match (first 10) ===');
    for (const r of noMatch.slice(0, 10)) {
      console.log(`  id=${r.id} symbol=${r.symbol} desc="${r.description.slice(0, 80)}"`);
    }
  }
  if (multiMatch.length > 0) {
    console.log('\n=== Multi-match (review) ===');
    for (const r of multiMatch.slice(0, 10)) {
      console.log(
        `  id=${r.id} symbol=${r.symbol} candidates=[${r.candidateIds.join(',')}] desc="${r.description.slice(0, 80)}"`,
      );
    }
  }

  if (!commit) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
    await sequelize.close();
    return;
  }

  let updated = 0;
  for (const m of matches) {
    await InvestmentActivity.update(
      { securityId: m.securityId },
      { where: { id: m.id } },
    );
    updated += 1;
  }
  console.log(`\n=== Commit ===\n  Updated: ${updated} rows`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
