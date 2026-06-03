#!/usr/bin/env tsx
/**
 * Backfill verified Costco product images for existing receipt items.
 *
 * Idempotent: item numbers already cached as resolved/not_found are skipped by
 * the resolver. `--limit N` caps how many NEW item numbers are attempted this
 * run (budget guard); `--household-id N` restricts the source orders.
 *
 * Usage on Railway:
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoProductImages.ts --dry-run
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoProductImages.ts --limit 50
 */
import { Op } from 'sequelize';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models';
import {
  RESOLVE_VENDORS,
  resolveCostcoProductsForItemNumbers,
  strictResolver,
  type ItemNumberToResolve,
} from '../src/import/enrichment/resolveCostcoProducts';
import { costcoEnrichmentEnabled } from '../src/config/env';
import { getCostcoScraperConfig } from '../src/config/costco';
import { defaultCostcoScraperCaller } from '../src/integrations/costco/scraperClient';

type Flags = { dryRun: boolean; limit: number | null; householdId: number | null };

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    limit: intFlag('--limit'),
    householdId: intFlag('--household-id'),
  };
}

async function loadCandidates(flags: Flags): Promise<ItemNumberToResolve[]> {
  const orderWhere: Record<string, unknown> = {
    vendor: { [Op.in]: RESOLVE_VENDORS as unknown as string[] },
    householdId: { [Op.ne]: null },
  };
  if (flags.householdId != null) orderWhere.householdId = flags.householdId;

  const items = await ExternalOrderItem.findAll({
    where: { itemNumber: { [Op.ne]: null } },
    include: [{ model: ExternalOrder, as: 'order', required: true, where: orderWhere, attributes: ['id'] }],
    attributes: ['id', 'itemNumber', 'displayName', 'title'],
    order: [['id', 'ASC']],
  });

  const byNumber = new Map<string, string>();
  for (const it of items) {
    if (it.itemNumber) byNumber.set(it.itemNumber, it.displayName ?? it.title);
  }
  return [...byNumber.entries()].map(([itemNumber, name]) => ({ itemNumber, name }));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[backfill-costco-images] flags:', flags);

  if (!flags.dryRun && (!costcoEnrichmentEnabled || getCostcoScraperConfig() == null)) {
    console.error('[backfill-costco-images] aborting: COSTCO_ENRICHMENT_ENABLED not true or COSTCO_SCRAPER_API_KEY not set. Use --dry-run to preview.');
    await sequelize.close();
    process.exit(1);
  }

  const candidates = await loadCandidates(flags);
  console.log(`[backfill-costco-images] ${candidates.length} distinct Costco item number(s) on receipts`);

  if (flags.dryRun) {
    console.log('[backfill-costco-images] DRY RUN — no scraper calls, no writes.');
    await sequelize.close();
    return;
  }

  const caller = defaultCostcoScraperCaller();
  if (caller == null) {
    console.error('[backfill-costco-images] no scraper caller configured');
    await sequelize.close();
    process.exit(1);
  }

  const resolved = await resolveCostcoProductsForItemNumbers(
    candidates,
    strictResolver(caller),
    flags.limit != null ? { maxItems: flags.limit } : undefined,
  );
  console.log(`[backfill-costco-images] done: newly resolved=${resolved}`);
  await sequelize.close();
}

main().catch((err) => {
  console.error('[backfill-costco-images] failed:', err);
  process.exit(1);
});
