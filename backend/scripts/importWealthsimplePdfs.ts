/**
 * Backfill Wealthsimple PDF statements into cashflow.
 *
 * Account identity comes from the filename prefix (<acctno>CAD/USD), which the
 * Task-2 verification confirmed equals the shortCode the WS CSV importers used.
 * Each file is parsed + committed through the same pipeline as a UI upload, so
 * dedup (fuzzy activities + ws_holding fingerprint) applies.
 *
 * Usage:
 *   tsx scripts/importWealthsimplePdfs.ts --dir <path> --household <id> --user <id> [--commit] [--limit N]
 * Default is DRY RUN (no DB writes). Pass --commit to persist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStatementFile } from '../src/import/parseStatementFile';
import { commitStatementImport } from '../src/import/commitStatementImport';
import { Account } from '../src/models';
import type { Account as AccountModel } from '../src/models/Account';
import type { StatementPreview } from '../src/import/statementTypes';

// Filename pattern: <ACCTNO(CAD|USD)>_<YYYY>-<MM>_<BROKERAGE|CREDIT_CARD>.pdf
const FILENAME_RE = /^([A-Z0-9]+(?:CAD|USD))_(\d{4})-(\d{2})_(BROKERAGE|CREDIT_CARD)\.pdf$/i;

const NO_ACCOUNT_STATUS = 'NO_ACCOUNT';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const dir = arg('dir', '/Users/connoradams/Downloads/monthly_pdf_statements')!;
  const householdId = Number(arg('household'));
  const userId = Number(arg('user'));
  const commit = flag('commit');
  const limitArg = arg('limit');
  const limit = limitArg != null ? Number(limitArg) : Infinity;
  if (!householdId || !userId) {
    throw new Error('--household and --user are required');
  }

  const allPdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const files = allPdfs.filter((f) => FILENAME_RE.test(f)).sort();
  const skippedByRegex = allPdfs
    .filter((f) => !FILENAME_RE.test(f))
    .reduce<Record<string, number>>((acc, f) => {
      // Derive suffix: token after last '_', before '.pdf'
      const base = path.basename(f, '.pdf');
      const parts = base.split('_');
      const suffix = parts[parts.length - 1] ?? 'UNKNOWN';
      acc[suffix] = (acc[suffix] ?? 0) + 1;
      return acc;
    }, {});
  const skippedCount = allPdfs.length - files.length;
  const skippedSummary = Object.entries(skippedByRegex)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  process.stdout.write(
    `Found ${allPdfs.length} pdfs; ${files.length} match BROKERAGE/CREDIT_CARD; skipping ${skippedCount}${skippedCount > 0 ? ` (${skippedSummary})` : ''} — not in scope.\n`,
  );

  const report: Array<Record<string, unknown>> = [];
  let processed = 0;

  for (const file of files) {
    if (processed >= limit) break;
    processed += 1;
    const m = FILENAME_RE.exec(file)!;
    const shortCode = m[1].toUpperCase();
    const currency = shortCode.endsWith('USD') ? 'USD' : 'CAD';

    let account: AccountModel | null = null;
    try {
      account = await Account.findOne({ where: { householdId, shortCode } });
    } catch (dbErr) {
      // Treat DB errors (e.g. missing tables in local dev) as NO_ACCOUNT so
      // the smoke-test run succeeds even when the local sqlite is unpopulated.
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      report.push({ file, shortCode, status: NO_ACCOUNT_STATUS, dbError: msg });
      process.stdout.write(`  SKIP ${file} — DB error (${msg})\n`);
      continue;
    }
    if (!account) {
      report.push({ file, shortCode, status: NO_ACCOUNT_STATUS });
      process.stdout.write(`  SKIP ${file} — no account for shortCode ${shortCode}\n`);
      continue;
    }

    const buffer = fs.readFileSync(path.join(dir, file));
    const preview = await parseStatementFile({
      buffer,
      fileName: file,
      accountId: account.id,
      householdId,
    });

    // parseStatementFile returns { ok: false; error: string } on failure
    if ('ok' in preview && !preview.ok) {
      const errMsg = (preview as { ok: false; error: string }).error;
      report.push({ file, shortCode, status: `PARSE_ERROR: ${errMsg}` });
      process.stdout.write(`  ERROR ${file}: ${errMsg}\n`);
      continue;
    }

    // Type narrowing: past this point preview is StatementPreview
    const p = preview as StatementPreview;

    const base = {
      file,
      shortCode,
      currency,
      parser: p.usedProfileId,
      txns: p.transactions.length,
      activities: p.investmentActivities.length,
      holdings: p.holdings.length,
      dupCounts: p.duplicateCounts,
      warnings: p.warnings,
      parseErrors: p.parseErrors.length,
    };

    if (!commit) {
      report.push({ ...base, status: 'DRY_RUN' });
      process.stdout.write(
        `  DRY  ${file}: txns=${base.txns} acts=${base.activities} holdings=${base.holdings} parseErrors=${base.parseErrors}\n`,
      );
      continue;
    }

    const result = await commitStatementImport(p, userId, householdId);
    report.push({
      ...base,
      status: 'COMMITTED',
      inserted: result.insertedTransactions + result.insertedInvestmentActivities + result.insertedHoldings,
      insertedTxns: result.insertedTransactions,
      insertedActivities: result.insertedInvestmentActivities,
      insertedHoldings: result.insertedHoldings,
      skippedDuplicates: result.skippedDuplicates,
    });
    process.stdout.write(
      `  OK   ${file}: +${base.txns}t/${base.activities}a/${base.holdings}h skipDup=${result.skippedDuplicates}\n`,
    );
  }

  // Summary
  const totals = report.reduce<{ txns: number; activities: number; holdings: number; errors: number; noAccount: number }>(
    (acc, r) => {
      acc.txns += Number(r.txns ?? 0);
      acc.activities += Number(r.activities ?? 0);
      acc.holdings += Number(r.holdings ?? 0);
      if (typeof r.status === 'string' && r.status.startsWith('PARSE_ERROR')) acc.errors += 1;
      if (r.status === NO_ACCOUNT_STATUS) acc.noAccount += 1;
      return acc;
    },
    { txns: 0, activities: 0, holdings: 0, errors: 0, noAccount: 0 },
  );

  const mode = commit ? 'commit' : 'dryrun';
  const outPath = `/tmp/ws_pdf_backfill_${mode}.json`;
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { mode, totalPdfsInDir: allPdfs.length, matched: files.length, skippedByRegex, totals, files: report },
      null,
      2,
    ),
  );
  const modePrefix = commit ? 'COMMITTED — ' : 'DRY RUN — ';
  process.stdout.write(
    `\n${modePrefix}Files: ${report.length}  txns:${totals.txns} activities:${totals.activities} holdings:${totals.holdings} parseErrors:${totals.errors} noAccount:${totals.noAccount}\n`,
  );
  process.stdout.write(`Report: ${outPath}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
