/**
 * Persist allocated line-of-credit interest, and serve the unbilled tail.
 *
 * Two figures, and the whole point of this module is that they are stored
 * differently (see "Two figures, never merged" in
 * `docs/superpowers/specs/2026-09-15-loc-interest-attribution-design.md`):
 *
 *   - **charged** — each rate window's printed Applicable Interest, apportioned
 *     across borrowers by the balance they carried during that window. It traces
 *     to a document, so it PERSISTS: one `reimbursements` row per (rate window,
 *     contact) with `kind='interest'`.
 *   - **accrued** — the days since the last statement, at the current rate. RBC
 *     has billed nothing for them, so it is an estimate, and it changes every
 *     single day. It is computed on read and **never written**. Storing
 *     yesterday's estimate would make it indistinguishable from a billed fact the
 *     next time anyone read the table — precisely the error this feature exists
 *     to remove. `estimateAccrued` returns values; nothing in this file writes
 *     them, and `runInterestAllocation` never calls it.
 *
 * Idempotence is delete-then-insert, scoped to the windows just computed. The
 * partial unique index on `(source_rate_period_id, contact_id)` is the backstop,
 * not the mechanism.
 */
import { Op, type Transaction as DbTransaction } from 'sequelize';
import {
  Account,
  AccountRatePeriod,
  Contact,
  ProviderJobLog,
  Reimbursement,
  Transaction,
  sequelize,
} from '../models';
import { defaultCurrency } from '../config/env';
import { logger } from '../observability/logger';
import { findCancelledTransferIds } from './cancelPairing';
import {
  allocateWindowInterestDetailed,
  accrueSinceLastWindow,
  type InterestAllocation,
  type LedgerRow,
  type RateWindow,
  type WindowAllocationSummary,
} from './interestAllocation';

export const INTEREST_ALLOCATION_PROVIDER = 'loc_interest_allocation' as const;
/** The `reimbursements.kind` discriminator for a generated interest row. */
export const INTEREST_KIND = 'interest' as const;
/** The `reimbursements.kind` discriminator for a hand-logged claim. */
export const PRINCIPAL_KIND = 'principal' as const;

export interface InterestAllocationResult {
  /** Rate windows loaded. Zero when no statement has been imported yet. */
  windows: number;
  /** Charged rows written (or, under dryRun, that would be). */
  allocations: number;
  /** Fixed(4). Sum of the charged rows — never the accrued tail. */
  totalCharged: string;
  /** Per-window diagnostics, including the scaling factor. */
  windowSummaries: WindowAllocationSummary[];
  dryRun: boolean;
  elapsedMs: number;
}

/** One rate-carrying account and its windows. In practice: the Royal Credit Line. */
export interface InterestAccountContext {
  accountId: number;
  accountName: string;
  currency: string;
  windows: RateWindow[];
}

export interface InterestContext {
  accounts: InterestAccountContext[];
  /** Every contact-linked transaction in the household, cancelled legs removed. */
  rows: LedgerRow[];
}

const inFlight = new Set<number>();

export function isInterestAllocationRunning(householdId: number): boolean {
  return inFlight.has(householdId);
}

export function _resetInterestAllocationInFlightForTest(): void {
  inFlight.clear();
}

/**
 * Load the rate windows and the contact-linked ledger both figures are computed
 * from.
 *
 * The account is **resolved, not hardcoded**: whichever accounts carry rate
 * windows are the accounts with a rate, and today that is only the Royal Credit
 * Line. An explicit `accountId` narrows it. No rate windows at all is a normal
 * state — nothing has been imported yet — so it yields an empty context rather
 * than an error.
 */
export async function loadInterestContext(
  householdId: number,
  accountId?: number,
): Promise<InterestContext> {
  const periods = await AccountRatePeriod.findAll({
    where: {
      householdId,
      applicableInterest: { [Op.ne]: null },
      ...(accountId ? { accountId } : {}),
    },
    order: [['account_id', 'ASC'], ['from_date', 'ASC']],
  });
  if (periods.length === 0) return { accounts: [], rows: [] };

  const accountIds = [...new Set(periods.map((p) => p.accountId))];
  const accountRows = await Account.findAll({
    where: { householdId, id: { [Op.in]: accountIds } },
    attributes: ['id', 'name', 'defaultCurrency'],
  });
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  const accounts: InterestAccountContext[] = [];
  for (const id of accountIds) {
    const account = accountById.get(id);
    // A rate window whose account was deleted or belongs elsewhere earns nothing.
    if (!account) continue;
    accounts.push({
      accountId: id,
      accountName: account.name,
      currency: account.defaultCurrency ?? defaultCurrency,
      windows: periods
        .filter((p) => p.accountId === id)
        .map((p) => ({
          id: p.id,
          fromDate: String(p.fromDate).slice(0, 10),
          toDate: String(p.toDate).slice(0, 10),
          effectiveRate: p.effectiveRate,
          applicableInterest: p.applicableInterest ?? 0,
        })),
    });
  }

  return { accounts, rows: await loadLedgerRows(householdId) };
}

/**
 * Every contact-linked transaction, with its contact's `loanDefault` attached.
 *
 * Self-account contacts are excluded (you cannot owe yourself interest any more
 * than you can owe yourself principal), and both legs of a cancelled e-transfer
 * pair are dropped — the same exclusions `GET /:id/ledger` applies to principal,
 * so the two figures cannot disagree about what a loan is.
 */
async function loadLedgerRows(householdId: number): Promise<LedgerRow[]> {
  const contacts = await Contact.findAll({
    where: { householdId, isSelf: false },
    attributes: ['id', 'loanDefault'],
  });
  if (contacts.length === 0) return [];
  const loanDefaultById = new Map(contacts.map((c) => [c.id, c.loanDefault ?? false]));

  const txns = await Transaction.findAll({
    where: {
      householdId,
      counterpartyContactId: { [Op.in]: [...loanDefaultById.keys()] },
    },
    attributes: [
      'id', 'date', 'amount', 'currency',
      'counterpartyRole', 'counterpartyContactId', 'merchantRaw', 'merchantClean',
    ],
    order: [['date', 'ASC'], ['id', 'ASC']],
  });

  // Cancellation pairs are matched per contact: the pairing keys on the bank's
  // reference text, which is only unique within one counterparty's rows.
  const byContact = new Map<number, typeof txns>();
  for (const t of txns) {
    const cid = t.counterpartyContactId as number;
    const list = byContact.get(cid);
    if (list) list.push(t);
    else byContact.set(cid, [t]);
  }
  const cancelled = new Set<number>();
  for (const list of byContact.values()) {
    for (const id of findCancelledTransferIds(
      list.map((t) => ({ id: t.id, merchantText: t.merchantRaw ?? t.merchantClean ?? null })),
    )) {
      cancelled.add(id);
    }
  }

  const rows: LedgerRow[] = [];
  for (const t of txns) {
    if (cancelled.has(t.id)) continue;
    const contactId = t.counterpartyContactId as number;
    rows.push({
      contactId,
      date: String(t.date).slice(0, 10),
      amount: t.amount,
      currency: t.currency,
      counterpartyRole: t.counterpartyRole ?? null,
      loanDefault: loanDefaultById.get(contactId) ?? false,
    });
  }
  return rows;
}

/** The charged figure: every window's apportioned interest, across all accounts. */
export function computeCharged(
  ctx: InterestContext,
): { allocations: InterestAllocation[]; windows: WindowAllocationSummary[] } {
  const allocations: InterestAllocation[] = [];
  const windows: WindowAllocationSummary[] = [];
  for (const account of ctx.accounts) {
    const detailed = allocateWindowInterestDetailed(account.windows, ctx.rows, account.currency);
    allocations.push(...detailed.allocations);
    windows.push(...detailed.windows);
  }
  return { allocations, windows };
}

/**
 * The accrued figure: the tail since each account's last billed window.
 *
 * Returned, never written. Every allocation here carries `rateWindowId: null`
 * because no statement backs it, which is also why it must be labelled an
 * estimate wherever it is shown.
 */
export function estimateAccrued(ctx: InterestContext, asOf: string): InterestAllocation[] {
  const out: InterestAllocation[] = [];
  for (const account of ctx.accounts) {
    // The window that ends last is the one whose rate is still in force.
    let last: RateWindow | null = null;
    for (const w of account.windows) {
      if (!last || w.toDate > last.toDate) last = w;
    }
    if (!last) continue;
    out.push(...accrueSinceLastWindow({
      lastWindowEnd: last.toDate,
      asOf,
      currentRate: last.effectiveRate,
      rows: ctx.rows,
      currency: account.currency,
    }));
  }
  return out;
}

/**
 * Recompute and persist the charged allocations for a household.
 *
 * Mirrors the in-flight guard and `ProviderJobLog` record of
 * `backend/src/import/transferContactLink.ts`: two concurrent runs would
 * interleave a delete with the other's insert and leave the table short.
 */
export async function runInterestAllocation(opts: {
  householdId: number;
  accountId?: number;
  /** Unused by the charged figure; accepted so callers can pin a run's date. */
  asOf?: string;
  dryRun?: boolean;
}): Promise<InterestAllocationResult> {
  const { householdId, accountId, dryRun = false } = opts;
  if (inFlight.has(householdId)) {
    throw new Error(`interest allocation already running for household ${householdId}`);
  }
  inFlight.add(householdId);
  const startedAt = Date.now();
  let windowCount = 0;
  let allocations: InterestAllocation[] = [];
  let windowSummaries: WindowAllocationSummary[] = [];
  let status: 'ok' | 'error' = 'ok';

  try {
    const ctx = await loadInterestContext(householdId, accountId);
    windowCount = ctx.accounts.reduce((n, a) => n + a.windows.length, 0);
    const charged = computeCharged(ctx);
    allocations = charged.allocations;
    windowSummaries = charged.windows;

    if (!dryRun && windowCount > 0) {
      const windowIds = ctx.accounts.flatMap((a) => a.windows.map((w) => w.id));
      await sequelize.transaction(async (tx: DbTransaction) => {
        // Delete-then-insert is the mechanism. Scoped to the windows just
        // recomputed so a narrowed `accountId` run cannot wipe another
        // account's rows.
        await Reimbursement.destroy({
          where: {
            householdId,
            kind: INTEREST_KIND,
            sourceRatePeriodId: { [Op.in]: windowIds },
          },
          transaction: tx,
          force: true,
        });
        if (allocations.length > 0) {
          const windowById = new Map(
            ctx.accounts.flatMap((a) => a.windows).map((w) => [w.id, w]),
          );
          await Reimbursement.bulkCreate(
            allocations.map((a) => ({
              householdId,
              // No outlay: this is owed for a period, not for one transaction.
              transactionId: null,
              contactId: a.contactId,
              partyName: null,
              amount: a.amount,
              currency: a.currency,
              // The window's last day is the day the interest was billed.
              dueDate: a.rateWindowId != null
                ? (windowById.get(a.rateWindowId)?.toDate ?? null)
                : null,
              status: 'expected' as const,
              repaymentTransactionId: null,
              receivedAt: null,
              createdByUserId: null,
              notes: null,
              kind: INTEREST_KIND,
              sourceTransactionId: null,
              sourceRatePeriodId: a.rateWindowId,
            })),
            { transaction: tx },
          );
        }
      });
    }
  } catch (err) {
    status = 'error';
    logger.error({ err, householdId, module: 'loc_interest_allocation' }, 'interest_allocation_failed');
    throw err;
  } finally {
    inFlight.delete(householdId);
  }

  const totalCharged = sumFixed4(allocations.map((a) => a.amount));
  const elapsedMs = Date.now() - startedAt;
  if (!dryRun) {
    await ProviderJobLog.create({
      provider: INTEREST_ALLOCATION_PROVIDER,
      function: 'allocate',
      symbol: String(householdId),
      status,
      httpStatus: null,
      errorMessage: JSON.stringify({
        windows: windowCount, allocations: allocations.length, totalCharged, elapsedMs,
      }),
      fetchedAt: new Date(),
    });
  }

  return {
    windows: windowCount,
    allocations: allocations.length,
    totalCharged,
    windowSummaries,
    dryRun,
    elapsedMs,
  };
}

/**
 * Sum fixed(4) strings without a float ever holding money.
 *
 * Exported because the ledger route folds the persisted rows the same way, and
 * two different summing rules would put two different totals on one page.
 */
export function sumFixed4(amounts: Array<string | number>): string {
  let units = 0n;
  for (const a of amounts) units += toUnits4(a);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  return `${negative ? '-' : ''}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, '0')}`;
}

/** A fixed(4) string or a DECIMAL-as-number into integer 1/10_000 units. */
function toUnits4(amount: string | number): bigint {
  return BigInt(Math.round(Number(amount) * 10_000));
}
