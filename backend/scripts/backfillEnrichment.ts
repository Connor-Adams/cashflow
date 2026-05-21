#!/usr/bin/env tsx
/**
 * CLI entrypoint for the enrichment backfill.
 *
 * The actual implementation lives in src/import/runEnrichmentBackfill.ts so it
 * can be shared with the HTTP route. This file is just argv parsing + invocation.
 *
 * Flags:
 *   --dry-run            print would-update count, write nothing
 *   --no-review-flag     don't touch review_flag (only enrich descriptive fields)
 *   --review-only        only re-enrich rows currently in review (review_flag=true)
 *   --account-id N       filter to one account
 *   --household-id N     filter to one household
 *   --limit N            process at most N rows
 *   --batch-size N       fetch batch size (default 100)
 *   --verbose            print per-row decision
 *
 * Usage on Railway:
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillEnrichment.ts --dry-run
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillEnrichment.ts
 */
import { sequelize } from '../src/models';
import { runBackfill, type BackfillFlags } from '../src/import/runEnrichmentBackfill';

function parseFlags(argv: string[]): BackfillFlags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    noReviewFlag: argv.includes('--no-review-flag'),
    reviewOnly: argv.includes('--review-only'),
    verbose: argv.includes('--verbose'),
    accountId: intFlag('--account-id'),
    householdId: intFlag('--household-id'),
    limit: intFlag('--limit'),
    batchSize: intFlag('--batch-size') ?? 100,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[backfill] starting with flags:', flags);
  const result = await runBackfill(flags);
  console.log(
    `[backfill] done: processed=${result.processed} updated=${result.updated} reviewCleared=${result.reviewFlagCleared} signalsWritten=${result.signalsWritten} skipped=${result.skipped}${flags.dryRun ? ' (DRY RUN, no writes)' : ''}`,
  );
  await sequelize.close();
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
