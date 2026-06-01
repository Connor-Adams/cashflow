/**
 * Retroactive counterparty backfill (issue #376, follow-up to #372).
 *
 * #372 deliberately skipped backfill so the initial migration stayed cheap
 * and legacy `counterparty_raw` was NULL. Households who'd already imported
 * years of statements only got value on *new* imports. This job walks all
 * pre-existing in-scope rows (checking | savings | cash) where
 * `counterparty_raw IS NULL` and re-runs `extractCounterparty` over the
 * raw merchant line.
 *
 * Safety:
 *   - Idempotent. The NULL filter excludes rows the user (or a later import)
 *     already populated, so re-runs don't overwrite anything.
 *   - Scoped per household. The route layer authenticates the caller and
 *     passes `householdId` in; this module never sweeps cross-household.
 *   - Chunked. Walks rows in batches (default 200) ordered by (date, id) so
 *     the result is deterministic and the working set stays bounded.
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
  skipped: number;
  elapsedMs: number;
  dryRun: boolean;
}

export interface CounterpartyBackfillRunRecord {
  fetchedAt: Date;
  status: 'ok' | 'error';
  summary: { processed: number; extracted: number; elapsedMs: number };
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
  let summary = { processed: 0, extracted: 0, elapsedMs: 0 };
  if (row.errorMessage) {
    try {
      const parsed = JSON.parse(row.errorMessage) as Partial<typeof summary>;
      summary = {
        processed: Number(parsed.processed ?? 0),
        extracted: Number(parsed.extracted ?? 0),
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
  let skipped = 0;
  let status: 'ok' | 'error' = 'ok';
  let errorMessage: string | null = null;

  try {
    // We load Account.accountType inline via include so we don't need a
    // per-account cache; extractCounterparty wants the type for the
    // in-scope check.
    //
    // We deliberately never advance an OFFSET — each iteration's UPDATE
    // shrinks the result set (rows that got a counterparty now fail the
    // NULL filter), so re-querying with `WHERE counterpartyRaw IS NULL`
    // already returns "the next chunk". We track which rows produced
    // a null extraction so we can paginate past them, since those stay
    // visible in the filter forever and would otherwise loop indefinitely.
    const seenNullIds = new Set<number>();
    while (true) {
      const where: Record<string, unknown> = {
        householdId,
        counterpartyRaw: { [Op.is]: null },
      };
      if (seenNullIds.size > 0) {
        where.id = { [Op.notIn]: Array.from(seenNullIds) };
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
          accountType: acc.accountType,
        };
      });

      // Plan extractions for this batch up-front so the per-row DB write is
      // a single UPDATE inside one transaction.
      const updates: Array<{ id: number; counterparty: string; merchantRaw: string }> = [];
      for (const r of rows) {
        try {
          const _cp = extractCounterparty(r.merchantRaw, r.accountType);
          const value = _cp?.name ?? null;
          processed++;
          if (value != null) {
            extracted++;
            if (!dryRun) {
              updates.push({ id: r.id, counterparty: value, merchantRaw: r.merchantRaw });
            } else {
              // In dryRun the row stays NULL; remember it so the next
              // iteration skips past it instead of re-loading it forever.
              seenNullIds.add(r.id);
            }
            callbacks.onProgress?.({
              txnId: r.id,
              merchantRaw: r.merchantRaw,
              counterpartyRaw: value,
            });
          } else {
            // No pattern matched — row will keep counterpartyRaw=NULL and
            // remain visible to the filter. Mark it as seen so the loop
            // doesn't get stuck on it.
            seenNullIds.add(r.id);
            callbacks.onProgress?.({
              txnId: r.id,
              merchantRaw: r.merchantRaw,
              counterpartyRaw: null,
            });
          }
        } catch (err) {
          skipped++;
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, txnId: r.id, module: 'counterparty_backfill' },
            'counterparty_backfill_row_failed',
          );
          callbacks.onError?.({ txnId: r.id, message });
        }
      }

      if (updates.length > 0) {
        await sequelize.transaction(async (t) => {
          for (const u of updates) {
            // Belt-and-suspenders: WHERE counterpartyRaw IS NULL re-asserts
            // the idempotency invariant at write time. If a concurrent caller
            // already populated the row in the same tick, we skip silently.
            await Transaction.update(
              { counterpartyRaw: u.counterparty },
              {
                where: {
                  id: u.id,
                  counterpartyRaw: { [Op.is]: null },
                },
                transaction: t,
              },
            );
          }
        });
      }

      // Periodic progress log for long sweeps.
      if (processed % 500 === 0) {
        logger.info(
          { householdId, processed, extracted, skipped, module: 'counterparty_backfill' },
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
  const summary = { processed, extracted, elapsedMs };

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
    skipped,
    elapsedMs,
    dryRun,
  };
}
