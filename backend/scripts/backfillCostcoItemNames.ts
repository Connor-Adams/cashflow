#!/usr/bin/env tsx
/**
 * Backfill AI-expanded readable item names (display_name) for existing Costco
 * receipt items.
 *
 * Idempotent: by default only items whose display_name IS NULL are expanded, so
 * re-running is safe and cheap. `--force` re-expands every Costco item
 * (overwriting prior display_names). `--limit N` caps total items processed.
 *
 * Vendor scope is the allowlist in src/import/enrichment/expandItemNames.ts
 * (Costco only today). The actual AI call lives in that module so it can be
 * unit/integration tested with an injected caller; this script is argv parsing
 * + per-household orchestration, mirroring scripts/backfillEnrichment.ts.
 *
 * Flags:
 *   --force          re-expand items that already have a display_name
 *   --limit N        process at most N items total (across households)
 *   --household-id N restrict to one household
 *   --dry-run        print how many items WOULD be expanded, call no AI, write nothing
 *
 * Usage on Railway:
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoItemNames.ts --dry-run
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillCostcoItemNames.ts
 */
import { Op } from 'sequelize';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models';
import {
  EXPANSION_VENDORS,
  expandCostcoItemNames,
  applyItemNameExpansions,
} from '../src/import/enrichment/expandItemNames';
import { enrichmentAiEnabled } from '../src/config/env';
import { getOpenAiConfig } from '../src/config/openai';

type Flags = {
  force: boolean;
  dryRun: boolean;
  limit: number | null;
  householdId: number | null;
};

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    limit: intFlag('--limit'),
    householdId: intFlag('--household-id'),
  };
}

/**
 * The set of item IDs eligible for expansion: items on Costco orders (vendor in
 * the allowlist), optionally scoped to a household, and (unless --force) only
 * those whose display_name IS NULL. Grouped by household so each household's
 * items are expanded together.
 */
async function loadEligibleItemIdsByHousehold(
  flags: Flags,
): Promise<Map<number, number[]>> {
  const orderWhere: Record<string, unknown> = {
    vendor: { [Op.in]: EXPANSION_VENDORS as unknown as string[] },
    householdId: { [Op.ne]: null },
  };
  if (flags.householdId != null) orderWhere.householdId = flags.householdId;

  const itemWhere: Record<string, unknown> = {};
  if (!flags.force) itemWhere.displayName = { [Op.is]: null };

  const items = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [
      {
        model: ExternalOrder,
        as: 'order',
        required: true,
        where: orderWhere,
        attributes: ['id', 'householdId'],
      },
    ],
    attributes: ['id'],
    order: [['id', 'ASC']],
    ...(flags.limit != null ? { limit: flags.limit } : {}),
  });

  const byHousehold = new Map<number, number[]>();
  for (const item of items) {
    const order = (item as ExternalOrderItem & { order?: ExternalOrder }).order;
    const hh = order?.householdId;
    if (hh == null) continue;
    const list = byHousehold.get(hh) ?? [];
    list.push(item.id);
    byHousehold.set(hh, list);
  }
  return byHousehold;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[backfill-costco-names] starting with flags:', flags);

  if (!flags.dryRun && (!enrichmentAiEnabled || getOpenAiConfig() == null)) {
    console.error(
      '[backfill-costco-names] aborting: enrichment AI disabled or OPENAI_API_KEY not set. ' +
        'Set ENRICHMENT_AI_ENABLED=true and OPENAI_API_KEY, or use --dry-run.',
    );
    await sequelize.close();
    process.exit(1);
  }

  const byHousehold = await loadEligibleItemIdsByHousehold(flags);
  const totalItems = [...byHousehold.values()].reduce((s, ids) => s + ids.length, 0);
  console.log(
    `[backfill-costco-names] eligible: ${totalItems} item(s) across ${byHousehold.size} household(s)` +
      `${flags.force ? ' (force: includes already-named items)' : ''}`,
  );

  if (flags.dryRun) {
    console.log('[backfill-costco-names] DRY RUN — no AI calls, no writes.');
    await sequelize.close();
    return;
  }

  let updated = 0;
  for (const [householdId, itemIds] of byHousehold) {
    try {
      const { suggestions } = await expandCostcoItemNames({ householdId, itemIds });
      const n = await applyItemNameExpansions(suggestions);
      updated += n;
      console.log(
        `[backfill-costco-names] household=${householdId} items=${itemIds.length} expanded=${n}`,
      );
    } catch (err) {
      console.error(`[backfill-costco-names] household=${householdId} failed:`, err);
    }
  }

  console.log(`[backfill-costco-names] done: updated=${updated} of eligible=${totalItems}`);
  await sequelize.close();
}

main().catch((err) => {
  console.error('[backfill-costco-names] failed:', err);
  process.exit(1);
});
