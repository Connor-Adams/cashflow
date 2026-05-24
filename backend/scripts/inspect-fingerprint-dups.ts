#!/usr/bin/env tsx
/**
 * Dry-run inspector for the rebuild-transaction-fingerprint-from-raw
 * migration. Lists every Transaction the migration would delete (a losing
 * copy of a duplicate that the merchant_clean -> merchant_raw fingerprint
 * change collapses) and prints the chosen survivor for each group.
 *
 * Survivor policy mirrors the migration: prefer the row with user edits
 * (category_override / business_override / split_override / reviewed_at),
 * ties go to the lowest id.
 *
 * Usage:
 *   cd backend && DATABASE_URL=... npx tsx scripts/inspect-fingerprint-dups.ts
 *
 * Outputs nothing to write — read-only.
 */
import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/models';

type Row = {
  id: number;
  account_id: number;
  date: string;
  amount: string;
  currency: string;
  merchant_raw: string;
  merchant_clean: string;
  source_reference: string | null;
  category_override: string | null;
  business_override: boolean | null;
  split_override: string | null;
  reviewed_at: Date | null;
  created_at: Date;
};

function computeNewFingerprint(row: Row): string {
  const data = {
    accountId: row.account_id,
    date: row.date,
    amount: String(parseFloat(row.amount)),
    currency: String(row.currency || '').toUpperCase(),
    merchantRaw: String(row.merchant_raw || ''),
    sourceReference: row.source_reference || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function hasEdits(r: Row): boolean {
  return (
    r.category_override != null ||
    r.business_override != null ||
    r.split_override != null ||
    r.reviewed_at != null
  );
}

async function main() {
  const rows = await sequelize.query<Row>(
    `SELECT id, account_id, date, amount, currency, merchant_raw, merchant_clean,
            source_reference, category_override, business_override, split_override,
            reviewed_at, created_at
     FROM transactions
     ORDER BY id ASC`,
    { type: QueryTypes.SELECT }
  );

  type Group = { winner: Row; edited: boolean; losers: Row[] };
  const groups = new Map<string, Group>();

  for (const row of rows) {
    const fp = computeNewFingerprint(row);
    const key = `${row.account_id}|${fp}`;
    const edited = hasEdits(row);
    const g = groups.get(key);
    if (g == null) {
      groups.set(key, { winner: row, edited, losers: [] });
      continue;
    }
    if (edited && !g.edited) {
      g.losers.push(g.winner);
      g.winner = row;
      g.edited = true;
    } else {
      g.losers.push(row);
    }
  }

  const dupGroups = [...groups.values()].filter((g) => g.losers.length > 0);
  const totalLosers = dupGroups.reduce((acc, g) => acc + g.losers.length, 0);

  console.log(`Scanned ${rows.length} transactions.`);
  console.log(`Duplicate groups: ${dupGroups.length}`);
  console.log(`Rows that will be deleted: ${totalLosers}\n`);

  if (dupGroups.length === 0) {
    await sequelize.close();
    return;
  }

  for (const g of dupGroups) {
    const w = g.winner;
    console.log(
      `acct=${w.account_id} ${w.date} ${w.amount} ${w.currency} "${w.merchant_raw}"` +
        (w.source_reference ? ` ref=${w.source_reference}` : '')
    );
    console.log(
      `  KEEP id=${w.id} clean="${w.merchant_clean}" edits=${hasEdits(w) ? 'YES' : 'no'} created=${w.created_at.toISOString()}`
    );
    for (const l of g.losers) {
      console.log(
        `  DROP id=${l.id} clean="${l.merchant_clean}" edits=${hasEdits(l) ? 'YES' : 'no'} created=${l.created_at.toISOString()}`
      );
    }
  }

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
