#!/usr/bin/env tsx
/**
 * Backfill daily CLOSE prices (in CAD) for crypto securities that have
 * staking rewards needing valuation. Fetches the `<SYMBOL>-CAD` Yahoo
 * ticker so close is already CAD (DOT/ETH both have CAD pairs); rows are
 * tagged source='yahoo-cad'. Idempotent: upsert on (security_id, date).
 *
 * Usage (PROD Postgres — NEVER local sqlite):
 *   PUB=$(railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL)
 *   cd backend
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01            # dry-run (default)
 *   DATABASE_URL="$PUB" npx tsx scripts/backfill-crypto-daily-prices.ts --symbols DOT,ETH --since 2024-10-01 --commit   # apply
 *
 * Do NOT use `railway run` — it injects the internal-only DATABASE_URL
 * (*.railway.internal) which is unreachable from a laptop.
 *
 * Flags:
 *   --commit          Actually write. Default is dry-run (report only).
 *   --symbols X,Y     Comma-separated list of crypto symbols (default: DOT,ETH).
 *   --since YYYY-MM-DD  Start date for price history (default: 2024-10-01).
 */
import { Security, SecurityDailyPrice, sequelize } from '../src/models';
import { fetchDailyHistory } from '../src/integrations/yahoo/client';
import { strFlag, guardWriteTarget } from './lib/opsFlags';

async function backfillSymbol(symbol: string, since: string, commit: boolean): Promise<void> {
  const sec = await Security.findOne({ where: { symbol, assetType: 'cryptocurrency' } });
  if (!sec) { console.warn(`no cryptocurrency security for ${symbol}; skipping`); return; }
  const ticker = `${symbol}-CAD`;
  const bars = await fetchDailyHistory(ticker, { period1: since });
  if (!bars || bars.length === 0) { console.warn(`no bars for ${ticker}`); return; }
  console.log(`${ticker}: ${bars.length} daily bars from ${bars[0].date} to ${bars[bars.length - 1].date}`);
  if (!commit) return;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const symbols = (strFlag(argv, '--symbols') ?? 'DOT,ETH').split(',').map((s) => s.trim().toUpperCase());
  const since = strFlag(argv, '--since') ?? '2024-10-01';
  const mode = commit ? 'COMMIT (writing)' : 'DRY RUN (report only)';

  guardWriteTarget(commit);
  console.log(`mode: ${mode}`);

  for (const symbol of symbols) {
    await backfillSymbol(symbol, since, commit);
  }
  await sequelize.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
