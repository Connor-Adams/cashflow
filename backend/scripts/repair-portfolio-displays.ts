#!/usr/bin/env tsx
/**
 * One-off repair for the portfolio display bugs fixed in this branch:
 *   - forward income overstated by closed accounts (forwardIncomeBuilder fix)
 *   - daily snapshots valued at $0 (carry-forward + broker-value fallback fix)
 *
 * Modes:
 *   forward       rebuild portfolio_forward_projections for all households
 *   verify-snap   rebuild the last 3 days for household 1 and print rows (sanity)
 *   rebuild-snap  markStale + full rebuild of portfolio_daily_snapshots for every
 *                 household, from its earliest existing snapshot date
 *
 * Run against prod with DATABASE_URL pointed at the public TCP proxy.
 */
import { sequelize } from '../src/db';
import { Household } from '../src/models';
import { PortfolioDailySnapshot } from '../src/models/PortfolioDailySnapshot';
import { rebuildForwardProjectionsForAllHouseholds } from '../src/portfolio/forwardIncomeBuilder';
import {
  markDailySnapshotsStaleForHousehold,
  buildDailySnapshotsForHousehold,
} from '../src/portfolio/dailySnapshotBuilder';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

async function main() {
  const mode = process.argv[2];

  if (mode === 'forward') {
    const r = await rebuildForwardProjectionsForAllHouseholds();
    console.log('[forward] rebuilt:', JSON.stringify(r));
  } else if (mode === 'verify-snap') {
    const hh = 1;
    const to = iso(Date.now() - MS_PER_DAY);
    const from = iso(Date.now() - 3 * MS_PER_DAY);
    const r = await buildDailySnapshotsForHousehold({ householdId: hh, fromDate: from, toDate: to });
    console.log('[verify] build result:', JSON.stringify(r));
    const rows = await PortfolioDailySnapshot.findAll({
      where: { householdId: hh },
      order: [['date', 'DESC'], ['accountId', 'ASC']],
      limit: 18,
    });
    for (const row of rows) {
      console.log(`  ${row.date} acct ${row.accountId} mvCad=${row.marketValueCad} partial=${row.isPartial}`);
    }
  } else if (mode === 'rebuild-snap') {
    const households = await Household.findAll({ attributes: ['id'] });
    for (const hh of households) {
      const earliest = await PortfolioDailySnapshot.findOne({
        where: { householdId: hh.id },
        order: [['date', 'ASC']],
      });
      if (!earliest) {
        console.log(`[rebuild] hh ${hh.id}: no snapshots, skip`);
        continue;
      }
      const from = earliest.date;
      await markDailySnapshotsStaleForHousehold(hh.id, from);
      const r = await buildDailySnapshotsForHousehold({ householdId: hh.id, fromDate: from });
      console.log(`[rebuild] hh ${hh.id} from ${from}:`, JSON.stringify(r));
    }
  } else {
    throw new Error(`unknown mode: ${mode ?? '(none)'} — use forward | verify-snap | rebuild-snap`);
  }

  await sequelize.close();
}

main().catch((e) => {
  console.error('[repair-portfolio] failed:', e);
  process.exit(1);
});
