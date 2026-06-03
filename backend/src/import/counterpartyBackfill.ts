/**
 * Retroactive counterparty backfill (issue #376, follow-up to #372).
 *
 * #372 deliberately skipped backfill so the initial migration stayed cheap
 * and legacy `counterparty_raw` was NULL. Households who'd already imported
 * years of statements only got value on *new* imports. This job walks all
 * pre-existing in-scope rows (checking | savings | cash) where
 * `counterparty_contact_id IS NULL` (i.e. not yet linked to a Contact) and
 * re-runs `extractCounterparty` over the raw merchant line.
 *
 * For person-kind extractions it calls `resolveCounterpartyContact` to
 * find-or-create a Contact deduplicated by normalized name within the
 * household, then writes both `counterparty_raw` (if still NULL) and
 * `counterparty_contact_id` on the Transaction. Payroll / no-pattern rows
 * get `counterparty_raw` populated but no Contact (left raw-only).
 *
 * Safety:
 *   - Idempotent. The `counterparty_contact_id IS NULL` filter excludes rows
 *     already linked; payroll/no-pattern rows are added to `seenIds` to skip
 *     them on subsequent pages.
 *   - Scoped per household. The route layer authenticates the caller and
 *     passes `householdId` in; this module never sweeps cross-household.
 *   - Chunked. Walks rows in batches (default 200) ordered by (date, id) so
 *     the result is deterministic and the working set stays bounded.
 *   - Per-row transactions. Each row's resolve+update runs in its own
 *     Sequelize transaction so a unique-violation or error on one row rolls
 *     back only that row and the sweep continues.
 *   - Per-process serialised. A single household can't run two backfills
 *     concurrently; the second call rejects via `isCounterpartyBackfillRunning`.
 *
 * Observability:
 *   - One `ProviderJobLog` row is written at the end of every (non-dry) run
 *     with `provider='counterparty_backfill'`, `symbol=String(householdId)`,
 *     `function='backfill'`, and the summary JSON-encoded in
 *     `errorMessage` (the only free-text column on the model). Dry runs
 *     never write to the log so they don't disturb the 1h rate limit.
 */
import { Op } from 'sequelize';
import { Account, ProviderJobLog, Transaction, sequelize } from '../models';
import { extractCounterparty } from './extractCounterparty';
import { resolveCounterpartyContact } from '../contacts/findOrCreateContact';
import type { AccountType } from '@cashflow/shared';
import { logger } from '../observability/logger';

export const COUNTERPARTY_BACKFILL_PROVIDER = 'counterparty_backfill' as const;
export const COUNTERPARTY_BACKFILL_FUNCTION = 'backfill' as const;

/**
 * Account types this job inspects. Mirrors the in-scope set inside
 * `extractCounterparty` — keeping the filter at the SQL boundary too means
 * we never load out-of-scope rows in the first place.
 */
export const IN_SCOPE_ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'cash'];

export interface CounterpartyBackfillOptions {
  householdId: number;
  /** Page size. Defaults to 200; rows are walked oldest → newest. */
  batchSize?: number;
  /** If true, the extractor still runs but no DB write or log row is produced. */
  dryRun?: boolean;
}

export interface CounterpartyBackfillProgressEvent {
  txnId: number;
  merchantRaw: string;
  counterpartyRaw: string | null;
}

export interface CounterpartyBackfillErrorEvent {
  txnId: number;
  message: string;
}

export interface CounterpartyBackfillCallbacks {
  onProgress?: (e: CounterpartyBackfillProgressEvent) => void;
  onError?: (e: CounterpartyBackfillErrorEvent) => void;
}

export interface CounterpartyBackfillResult {
  processed: number;
  extracted: number;
  linked: number;
  skipped: number;
  elapsedMs: number;
  dryRun: boolean;
}

export interface CounterpartyBackfillRunRecord {
  fetchedAt: Date;
  status: 'ok' | 'error';
  summary: { processed: number; extracted: number; linked: number; elapsedMs: number };
}

// ---------------------------------------------------------------------------
// In-flight tracking — module-level Set keyed by householdId.
// Same shape as backfillRunning in backfillCoordinator.ts so the route layer
// can gate concurrent runs the same way.
// ---------------------------------------------------------------------------

const inFlight = new Set<number>();

export function isCounterpartyBackfillRunning(householdId: number): boolean {
  return inFlight.has(householdId);
}

/** Test-only helper — clears any leftover in-flight markers between cases. */
export function _resetCounterpartyBackfillInFlightForTest(): void {
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Last-run history (used by the GET /status route and the 1h rate limit).
// ---------------------------------------------------------------------------

export async function getLastCounterpartyBackfillRun(
  householdId: number,
): Promise<CounterpartyBackfillRunRecord | null> {
  const row = await ProviderJobLog.findOne({
    where: { provider: COUNTERPARTY_BACKFILL_PROVIDER, symbol: String(householdId) },
    order: [
      ['fetchedAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  if (!row) return null;
  let summary = { processed: 0, extracted: 0, linked: 0, elapsedMs: 0 };
  if (row.errorMessage) {
    try {
      const parsed = JSON.parse(row.errorMessage) as Partial<typeof summary>;
      summary = {
        processed: Number(parsed.processed ?? 0),
        extracted: Number(parsed.extracted ?? 0),
        linked: Number(parsed.linked ?? 0),
        elapsedMs: Number(parsed.elapsedMs ?? 0),
      };
    } catch {
      // Malformed log row — surface zeros so the UI still renders.
    }
  }
  return {
    fetchedAt: row.fetchedAt,
    status: row.status === 'ok' ? 'ok' : 'error',
    summary,
  };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

interface TxnRow {
  id: number;
  merchantRaw: string;
  counterpartyRaw: string | null;
  accountType: AccountType;
}

const COUNTERPARTY_BACKFILL_LOCK_HELD = 'COUNTERPARTY_BACKFILL_LOCK_HELD' as const;

export class CounterpartyBackfillInFlightError extends Error {
  code = COUNTERPARTY_BACKFILL_LOCK_HELD;
  constructor(householdId: number) {
    super(`counterparty backfill already running for household ${householdId}`);
  }
}

export async function runCounterpartyBackfill(
  opts: CounterpartyBackfillOptions,
  callbacks: CounterpartyBackfillCallbacks = {},
): Promise<CounterpartyBackfillResult> {
  const { householdId, batchSize = 200, dryRun = false } = opts;

  if (inFlight.has(householdId)) {
    throw new CounterpartyBackfillInFlightError(householdId);
  }

  inFlight.add(householdId);
  const startedAt = Date.now();
  let processed = 0;
  let extracted = 0;
  let linked = 0;
  let skipped = 0;
  let status: 'ok' | 'error' = 'ok';
  let errorMessage: string | null = null;

  try {
    // We load Account.accountType inline via include so we don't need a
    // per-account cache; extractCounterparty wants the type for the
    // in-scope check.
    //
    // We sweep rows where counterparty_contact_id IS NULL. Rows that
    // successfully get a Contact linked will disappear from this filter on
    // the next batch. Rows that extract to payroll or no-pattern (and thus
    // never get a contactId) are added to `seenIds` so we paginate past them
    // instead of looping forever.
    const seenIds = new Set<number>();
    while (true) {
      const where: Record<string, unknown> = {
        householdId,
        counterpartyContactId: { [Op.is]: null },
      };
      if (seenIds.size > 0) {
        where.id = { [Op.notIn]: Array.from(seenIds) };
      }
      const txns = await Transaction.findAll({
        where,
        include: [
          {
            model: Account,
            as: 'account',
            attributes: ['accountType'],
            required: true,
            where: { accountType: { [Op.in]: IN_SCOPE_ACCOUNT_TYPES } },
          },
        ],
        order: [
          ['date', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: batchSize,
      });
      if (txns.length === 0) break;

      // Materialise into a small shape we can iterate without re-coercing
      // the Sequelize instance every loop iteration.
      const rows: TxnRow[] = txns.map((t) => {
        const acc = (t as unknown as { account: { accountType: AccountType } }).account;
        return {
          id: t.id,
          merchantRaw: t.merchantRaw,
          counterpartyRaw: t.counterpartyRaw,
          accountType: acc.accountType,
        };
      });

      for (const r of rows) {
        processed++;
        try {
          const cp = extractCounterparty(r.merchantRaw, r.accountType);
          if (cp == null) {
            seenIds.add(r.id);
            callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: null });
            continue;
          }
          const rawWasNull = r.counterpartyRaw == null;
          if (dryRun) {
            if (rawWasNull) extracted++;
            seenIds.add(r.id);
            callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: cp.name });
            continue;
          }
          await sequelize.transaction(async (t) => {
            let contactId: number | null = null;
            if (cp.kind === 'person') {
              contactId = await resolveCounterpartyContact(householdId, cp, { transaction: t });
            }
            const patch: Record<string, unknown> = {};
            if (rawWasNull) patch.counterpartyRaw = cp.name;
            if (contactId != null) patch.counterpartyContactId = contactId;
            let affected = 0;
            if (Object.keys(patch).length > 0) {
              const [count] = await Transaction.update(patch, {
                where: { id: r.id, counterpartyContactId: { [Op.is]: null } },
                transaction: t,
              });
              affected = count;
            }
            // Only count rows we actually wrote. The WHERE re-asserts
            // counterpartyContactId IS NULL, so a concurrent importer that
            // linked this row first yields affected=0 — don't overcount.
            if (affected > 0) {
              if (rawWasNull) extracted++;
              if (contactId != null) linked++;
            }
            if (contactId == null) seenIds.add(r.id);
          });
          callbacks.onProgress?.({ txnId: r.id, merchantRaw: r.merchantRaw, counterpartyRaw: cp.name });
        } catch (err) {
          skipped++;
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, txnId: r.id, module: 'counterparty_backfill' }, 'counterparty_backfill_row_failed');
          callbacks.onError?.({ txnId: r.id, message });
          seenIds.add(r.id);
        }
      }

      // Periodic progress log for long sweeps.
      if (processed % 500 === 0) {
        logger.info(
          { householdId, processed, extracted, linked, skipped, module: 'counterparty_backfill' },
          'counterparty_backfill_progress',
        );
      }
    }
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, householdId, module: 'counterparty_backfill' },
      'counterparty_backfill_failed',
    );
  } finally {
    inFlight.delete(householdId);
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = { processed, extracted, linked, elapsedMs };

  if (!dryRun) {
    await ProviderJobLog.create({
      provider: COUNTERPARTY_BACKFILL_PROVIDER,
      function: COUNTERPARTY_BACKFILL_FUNCTION,
      symbol: String(householdId),
      status,
      httpStatus: null,
      errorMessage:
        status === 'ok' ? JSON.stringify(summary) : errorMessage ?? JSON.stringify(summary),
      fetchedAt: new Date(),
    });
    logger.info(
      { householdId, ...summary, status, module: 'counterparty_backfill' },
      'counterparty_backfill_completed',
    );
  }

  return {
    processed,
    extracted,
    linked,
    skipped,
    elapsedMs,
    dryRun,
  };
}
