#!/usr/bin/env tsx
/**
 * Backfill daily CLOSE prices (in CAD) for crypto securities that have
 * staking rewards needing valuation. Fetches the `<SYMBOL>-CAD` Yahoo
 * ticker so close is already CAD (DOT/ETH both have CAD pairs); rows are
 * tagged source='yahoo-cad'. Idempotent: upsert on (security_id, date).
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01 --dry-run
 *   cd backend && npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01
 */
import { Security, SecurityDailyPrice, sequelize } from '../src/models';
import { fetchDailyHistory } from '../src/integrations/yahoo/client';

function strFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 && i < argv.length - 1 ? argv[i + 1] : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const symbols = (strFlag(argv, '--symbols') ?? 'DOT,ETH').split(',').map((s) => s.trim().toUpperCase());
  const since = strFlag(argv, '--since') ?? '2024-10-01';

  for (const symbol of symbols) {
    const sec = await Security.findOne({ where: { symbol, assetType: 'cryptocurrency' } });
    if (!sec) { console.warn(`no cryptocurrency security for ${symbol}; skipping`); continue; }
    const ticker = `${symbol}-CAD`;
    const bars = await fetchDailyHistory(ticker, { period1: since });
    if (!bars || bars.length === 0) { console.warn(`no bars for ${ticker}`); continue; }
    console.log(`${ticker}: ${bars.length} daily bars from ${bars[0].date} to ${bars[bars.length - 1].date}`);
    if (dryRun) continue;
    for (const b of bars) {
      await SecurityDailyPrice.upsert({
        securityId: (sec as unknown as { id: number }).id,
        date: b.date,
        open: b.open == null ? null : String(b.open),
        high: b.high == null ? null : String(b.high),
        low: b.low == null ? null : String(b.low),
        close: String(b.close),
        adjClose: String(b.adjClose),
        volume: b.volume,
        source: 'yahoo-cad',
        fetchedAt: new Date(),
      });
    }
    console.log(`${ticker}: upserted ${bars.length} rows`);
  }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
