#!/usr/bin/env tsx
/**
 * Re-type historical credit-card payments that were stored before
 * `detectTypeStage` learned to recognize a pre-authorized debit naming a card
 * network.
 *
 * Prod at the time of writing: 38 rows on the single narrative
 * "Pre-authorized Debit to AMEX BILL PYMT" (2024-09 → 2026-06) typed
 * `transfer`, while the same narrative on rows written after the fix is typed
 * `payment`. The card side of each of those payments has always been `payment`,
 * so the two legs of one event disagreed.
 *
 * The decision comes from the detector itself (see retypeCardPayments.ts), not
 * a regex of its own, so this cannot drift from the import path. It only ever
 * promotes TO `payment`, and only on a high-confidence narrative match.
 *
 * Usage:
 *   cd backend && npx tsx scripts/retype-card-payments.ts            # dry run
 *   cd backend && npx tsx scripts/retype-card-payments.ts --apply
 *
 * Flags:
 *   --dry-run   Report what would change. Write nothing. DEFAULT.
 *   --apply     Actually write.
 *   --verbose   List every row, not just the per-narrative summary.
 */
import { Transaction, sequelize } from '../src/models';
import { shouldRetypeAsPayment } from '../src/import/retypeCardPayments';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type Candidate = { id: number; date: string; amount: string; from: string; merchantRaw: string };

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

function toCandidate(t: Transaction): Candidate | null {
  const merchantRaw = str(t.merchantRaw);
  const decided = shouldRetypeAsPayment({
    merchantRaw,
    merchantClean: str(t.merchantClean, merchantRaw),
    amount: Number(t.amount),
    txnType: t.txnType as string | null,
  });
  if (!decided) return null;
  return {
    id: t.id as number,
    date: str(t.date).slice(0, 10),
    amount: str(t.amount),
    from: str(t.txnType, 'null'),
    merchantRaw,
  };
}

async function findCandidates(): Promise<Candidate[]> {
  const rows = await Transaction.findAll({ order: [['date', 'ASC']] });
  return rows.map(toCandidate).filter((c): c is Candidate => c !== null);
}

function summarize(candidates: Candidate[]): void {
  const byNarrative = new Map<string, { n: number; from: Set<string> }>();
  for (const c of candidates) {
    const key = c.merchantRaw.slice(0, 60);
    const entry = byNarrative.get(key) ?? { n: 0, from: new Set<string>() };
    entry.n += 1;
    entry.from.add(c.from);
    byNarrative.set(key, entry);
  }
  console.log(`${candidates.length} row(s) would become 'payment':`);
  for (const [narrative, e] of [...byNarrative].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(e.n).padStart(4)}  ${[...e.from].join('/')} → payment   "${narrative}"`);
  }
}

function printRows(candidates: Candidate[]): void {
  for (const c of candidates) {
    console.log(`    #${c.id} ${c.date} ${c.amount} ${c.from} → payment  "${c.merchantRaw}"`);
  }
}

async function main(): Promise<void> {
  const candidates = await findCandidates();
  summarize(candidates);
  if (flag('verbose')) printRows(candidates);
  if (candidates.length === 0) return;

  if (!flag('apply')) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
    return;
  }

  const [updated] = await Transaction.update(
    { txnType: 'payment' },
    { where: { id: candidates.map((c) => c.id) }, fields: ['txnType'] },
  );
  console.log(`\nApplied: ${updated} row(s) re-typed to 'payment'.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
