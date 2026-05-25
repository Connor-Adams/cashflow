#!/usr/bin/env tsx
/**
 * Cross-source dedup importer for Wealthsimple's unified activities-export
 * CSV (single file covering ALL WS accounts and all activity types). Pairs
 * each CSV row against existing InvestmentActivity rows via fuzzy date-window
 * matching to avoid duplicating data already imported via per-account monthly
 * statements.
 *
 * Dry-run by default. Pass --commit to actually insert and backfill.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/importWsActivitiesExport.ts <file.csv>
 *   DATABASE_URL=... npx tsx scripts/importWsActivitiesExport.ts <file.csv> --commit
 *   DATABASE_URL=... npx tsx scripts/importWsActivitiesExport.ts <file.csv> --household-id 1
 */
import fs from 'fs';
import path from 'path';
import { UniqueConstraintError } from 'sequelize';
import { Account, InvestmentActivity, sequelize } from '../src/models';
import { parseCsvRecords } from '../src/import/csvParse';
import {
  parseActivitiesExportRow,
  isActivitiesExportHeaders,
  isAsOfFooterRow,
  type WsActivitiesExportRow,
} from '../src/import/wealthsimpleActivitiesExportParse';
import {
  findExistingInvestmentByFuzzyMatch,
  type FuzzyMatchOutcome,
} from '../src/import/fuzzyDedupInvestmentActivity';
import type { NormalizedInvestmentActivity } from '../src/import/statementTypes';

type Outcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'no-account'; shortCode: string }
  | { kind: 'insert'; activity: NormalizedInvestmentActivity }
  | {
      kind: 'dup';
      existingId: number;
      backfilledSettlement: string | null;
    }
  | { kind: 'review'; candidateIds: number[] }
  | { kind: 'error'; message: string };

type RowResult = {
  rowIndex: number;
  shortCode: string;
  activityType: string;
  activitySubType: string;
  csvDate: string;
  outcome: Outcome;
};

function parseArgs(argv: string[]): {
  file: string;
  commit: boolean;
  householdId: number | null;
  windowDays: number;
} {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'Usage: importWsActivitiesExport.ts <file.csv> [--commit] [--household-id N] [--window-days N]',
    );
    process.exit(1);
  }
  const commit = args.includes('--commit');
  const hhIdx = args.indexOf('--household-id');
  const householdId =
    hhIdx >= 0 && args[hhIdx + 1] ? Number(args[hhIdx + 1]) : null;
  const winIdx = args.indexOf('--window-days');
  const windowDays =
    winIdx >= 0 && args[winIdx + 1] ? Number(args[winIdx + 1]) : 5;
  return { file: path.resolve(file), commit, householdId, windowDays };
}

async function loadAccountIndex(
  householdId: number | null,
): Promise<Map<string, Account>> {
  const accounts = await Account.findAll({
    where: householdId == null ? {} : { householdId },
  });
  const index = new Map<string, Account>();
  for (const a of accounts) {
    if (a.shortCode) index.set(a.shortCode.toUpperCase(), a);
  }
  return index;
}

function pickCsvDate(activity: NormalizedInvestmentActivity): string {
  // Activities-export carries settlement_date for trades, NULL for dividends
  // and other rows. Old DB rows have `tradeDate` that equals execute-date for
  // trades and received-on-date for dividends. The fuzzy window absorbs the
  // skew either way, so use settlement_date when present (more reliable
  // anchor for trades) else tradeDate.
  return activity.settlementDate ?? activity.tradeDate;
}

async function classifyRow(args: {
  row: WsActivitiesExportRow;
  rowIndex: number;
  defaultCurrency: string;
  accountIndex: Map<string, Account>;
  windowDays: number;
}): Promise<RowResult> {
  const { row, rowIndex, defaultCurrency, accountIndex, windowDays } = args;
  const parsed = parseActivitiesExportRow(row, defaultCurrency);

  if (parsed.kind === 'skip') {
    return {
      rowIndex,
      shortCode: parsed.accountShortCode,
      activityType: parsed.activityType,
      activitySubType: parsed.activitySubType,
      csvDate: row.transaction_date,
      outcome: { kind: 'skipped', reason: parsed.reason },
    };
  }

  const account = accountIndex.get(parsed.accountShortCode.toUpperCase());
  if (!account) {
    return {
      rowIndex,
      shortCode: parsed.accountShortCode,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
      csvDate: row.transaction_date,
      outcome: { kind: 'no-account', shortCode: parsed.accountShortCode },
    };
  }

  const csvDate = pickCsvDate(parsed.activity);
  const outcome: FuzzyMatchOutcome = await findExistingInvestmentByFuzzyMatch({
    accountId: account.id,
    activityType: parsed.activity.activityType,
    symbol: parsed.activity.security?.symbol ?? null,
    quantity: parsed.activity.quantity,
    amount: parsed.activity.amount,
    currency: parsed.activity.currency,
    csvDate,
    windowDays,
  });

  if (outcome.kind === 'no-match') {
    return {
      rowIndex,
      shortCode: parsed.accountShortCode,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
      csvDate,
      outcome: { kind: 'insert', activity: parsed.activity },
    };
  }
  if (outcome.kind === 'single-match') {
    return {
      rowIndex,
      shortCode: parsed.accountShortCode,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
      csvDate,
      outcome: {
        kind: 'dup',
        existingId: outcome.existing.id,
        backfilledSettlement: outcome.backfillSettlement
          ? parsed.activity.settlementDate
          : null,
      },
    };
  }
  return {
    rowIndex,
    shortCode: parsed.accountShortCode,
    activityType: row.activity_type,
    activitySubType: row.activity_sub_type,
    csvDate,
    outcome: {
      kind: 'review',
      candidateIds: outcome.candidates.map((c) => c.id),
    },
  };
}

function rowToWs(record: Record<string, string>): WsActivitiesExportRow {
  return {
    transaction_date: record.transaction_date ?? '',
    settlement_date: record.settlement_date ?? '',
    account_id: record.account_id ?? '',
    account_type: record.account_type ?? '',
    activity_type: record.activity_type ?? '',
    activity_sub_type: record.activity_sub_type ?? '',
    direction: record.direction ?? '',
    symbol: record.symbol ?? '',
    name: record.name ?? '',
    currency: record.currency ?? '',
    quantity: record.quantity ?? '',
    unit_price: record.unit_price ?? '',
    commission: record.commission ?? '',
    net_cash_amount: record.net_cash_amount ?? '',
  };
}

async function commitInsert(
  result: RowResult & { outcome: Extract<Outcome, { kind: 'insert' }> },
  accountIndex: Map<string, Account>,
  batchLabel: string,
): Promise<'inserted' | 'fingerprint-duplicate'> {
  const account = accountIndex.get(result.shortCode.toUpperCase())!;
  const a = result.outcome.activity;
  // Security lookup deferred to a follow-up step: for the dry-run-then-ship
  // flow, the CLI inserts with security_id=NULL when no existing security
  // matches. A separate enrichment pass can backfill securities; this keeps
  // the import operation simple and lets Connor audit dry-run output first.
  //
  // Each insert wrapped in its own SAVEPOINT-style transaction so unique
  // violations on the (account_id, source_row_fingerprint) safety-net index
  // are swallowed and reported instead of aborting the whole run.
  try {
    await sequelize.transaction(async (t) => {
      await InvestmentActivity.create(
        {
          accountId: account.id,
          householdId: account.householdId,
          securityId: null,
          activityType: a.activityType,
          tradeDate: a.tradeDate,
          settlementDate: a.settlementDate,
          description: a.description,
          quantity: a.quantity == null ? null : String(a.quantity),
          price: a.price == null ? null : String(a.price),
          amount: a.amount == null ? null : String(a.amount),
          fees: a.fees == null ? null : String(a.fees),
          currency: a.currency,
          sourceReference: a.sourceReference,
          sourceRowFingerprint: a.sourceRowFingerprint,
          importBatch: batchLabel,
        },
        { transaction: t },
      );
    });
    return 'inserted';
  } catch (e) {
    if (e instanceof UniqueConstraintError) return 'fingerprint-duplicate';
    throw e;
  }
}

async function commitBackfill(
  result: RowResult & { outcome: Extract<Outcome, { kind: 'dup' }> },
): Promise<boolean> {
  if (!result.outcome.backfilledSettlement) return false;
  const existing = await InvestmentActivity.findByPk(result.outcome.existingId);
  if (!existing) return false;
  if (existing.settlementDate != null) return false;
  existing.settlementDate = result.outcome.backfilledSettlement;
  await existing.save({ fields: ['settlementDate'] });
  return true;
}

function summarize(results: RowResult[]): void {
  const counts = {
    skipped: 0,
    'no-account': 0,
    insert: 0,
    dup: 0,
    'dup-backfill': 0,
    review: 0,
    error: 0,
  };
  const byActivityType = new Map<string, Map<string, number>>();
  for (const r of results) {
    if (r.outcome.kind === 'dup') {
      counts.dup += 1;
      if (r.outcome.backfilledSettlement) counts['dup-backfill'] += 1;
    } else {
      counts[r.outcome.kind] += 1;
    }
    const k = `${r.activityType}/${r.activitySubType || '-'}`;
    if (!byActivityType.has(k)) byActivityType.set(k, new Map());
    const sub = byActivityType.get(k)!;
    sub.set(r.outcome.kind, (sub.get(r.outcome.kind) ?? 0) + 1);
  }
  console.log('\n=== Summary ===');
  console.log(JSON.stringify(counts, null, 2));
  console.log('\n=== By activity_type ===');
  for (const [k, sub] of [...byActivityType.entries()].sort()) {
    const parts = [...sub.entries()].map(([o, n]) => `${o}=${n}`).join(', ');
    console.log(`  ${k.padEnd(36)} ${parts}`);
  }
}

function printReviewRows(results: RowResult[]): void {
  const review = results.filter((r) => r.outcome.kind === 'review');
  if (review.length === 0) return;
  console.log('\n=== Review queue (multi-match) ===');
  for (const r of review) {
    if (r.outcome.kind !== 'review') continue;
    console.log(
      `  row ${r.rowIndex} | ${r.shortCode} | ${r.activityType}/${r.activitySubType} | ${r.csvDate} | candidates=[${r.outcome.candidateIds.join(',')}]`,
    );
  }
}

function printInsertSample(results: RowResult[]): void {
  const inserts = results.filter((r) => r.outcome.kind === 'insert');
  if (inserts.length === 0) return;
  const byType = new Map<string, RowResult[]>();
  for (const r of inserts) {
    const k = `${r.activityType}/${r.activitySubType || '-'}`;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k)!.push(r);
  }
  console.log('\n=== Insert sample (first 3 per activity_type, skipping CryptoStakingReward) ===');
  for (const [k, rows] of [...byType.entries()].sort()) {
    if (k.startsWith('CryptoStakingReward')) continue;
    console.log(`\n  ${k} (${rows.length} total):`);
    for (const r of rows.slice(0, 3)) {
      if (r.outcome.kind !== 'insert') continue;
      const a = r.outcome.activity;
      console.log(
        `    ${r.csvDate} | ${a.security?.symbol ?? '-'} | qty=${a.quantity ?? '-'} | amt=${a.amount ?? '-'} ${a.currency}`,
      );
    }
  }
}

function printNoAccountRows(results: RowResult[]): void {
  const noAcct = results.filter((r) => r.outcome.kind === 'no-account');
  if (noAcct.length === 0) return;
  const codes = [...new Set(noAcct.map((r) => r.shortCode))];
  console.log('\n=== Missing accounts (shortcode not in DB for this household) ===');
  for (const code of codes) {
    const n = noAcct.filter((r) => r.shortCode === code).length;
    console.log(`  ${code}: ${n} rows`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(opts.file)) {
    console.error(`File not found: ${opts.file}`);
    process.exit(1);
  }
  const text = fs.readFileSync(opts.file, 'utf8');
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) {
    console.error(`CSV parse failed: ${parsed.error}`);
    process.exit(1);
  }
  if (!isActivitiesExportHeaders(parsed.headers)) {
    console.error(
      `Headers do not match activities-export layout. Got: ${parsed.headers.join(',')}`,
    );
    process.exit(1);
  }

  console.log(`Mode: ${opts.commit ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`File: ${opts.file}`);
  console.log(`Rows: ${parsed.records.length}`);
  console.log(`Window: ±${opts.windowDays} days`);

  const accountIndex = await loadAccountIndex(opts.householdId);
  console.log(`Loaded ${accountIndex.size} accounts`);

  const results: RowResult[] = [];
  let i = 0;
  for (const record of parsed.records) {
    i += 1;
    const row = rowToWs(record);
    if (isAsOfFooterRow(row)) continue;

    try {
      const r = await classifyRow({
        row,
        rowIndex: i,
        defaultCurrency: 'CAD',
        accountIndex,
        windowDays: opts.windowDays,
      });
      results.push(r);
    } catch (e) {
      results.push({
        rowIndex: i,
        shortCode: row.account_id,
        activityType: row.activity_type,
        activitySubType: row.activity_sub_type,
        csvDate: row.transaction_date,
        outcome: {
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  summarize(results);
  printNoAccountRows(results);
  printReviewRows(results);
  printInsertSample(results);

  if (!opts.commit) {
    console.log('\nDry-run complete. Re-run with --commit to apply changes.');
    await sequelize.close();
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const batchLabel = `ws-activities-export-${ts}`;
  let inserted = 0;
  let fingerprintDups = 0;
  let backfilled = 0;
  for (const r of results) {
    if (r.outcome.kind === 'insert') {
      const outcome = await commitInsert(
        r as Parameters<typeof commitInsert>[0],
        accountIndex,
        batchLabel,
      );
      if (outcome === 'inserted') inserted += 1;
      else fingerprintDups += 1;
    } else if (r.outcome.kind === 'dup' && r.outcome.backfilledSettlement) {
      const ok = await commitBackfill(r as Parameters<typeof commitBackfill>[0]);
      if (ok) backfilled += 1;
    }
  }
  console.log(`\n=== Commit ===`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Fingerprint duplicates (safety net): ${fingerprintDups}`);
  console.log(`  Settlement backfilled: ${backfilled}`);
  console.log(`  Import batch: ${batchLabel}`);
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
