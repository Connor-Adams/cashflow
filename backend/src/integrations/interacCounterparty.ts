/**
 * Interac e-Transfer counterparty sync (Task 4 of Interac feature).
 *
 * Walks all nameless Interac e-Transfer transactions for a household, fetches
 * matching emails from Gmail, and:
 *   - Auto-applies a name + Contact link when the match is unambiguous.
 *   - Creates an `ai_suggestion` (kind='counterparty_email_match') when the
 *     match is ambiguous (multiple txns / multiple emails at the same amount).
 *   - Skips self-transfers (name === ownerName) from Contact creation but still
 *     writes counterpartyRaw.
 *
 * Safety:
 *   - Per-process in-flight lock via module-level `inFlight` Set.
 *   - Idempotent: the `counterpartyContactId IS NULL` filter and
 *     `WHERE counterpartyContactId IS NULL` in UPDATE prevent double-writes.
 *   - Gmail fetch is injectable via `opts.fetchEmails` so tests can stub it.
 *   - Dry runs never write to the DB or ProviderJobLog.
 *
 * Observability:
 *   - One `ProviderJobLog` row per non-dry run
 *     (provider='interac_counterparty_sync', function='sync',
 *      symbol=householdId, errorMessage=JSON summary or error text).
 */
import { Op } from 'sequelize';
import {
  Account,
  AiSuggestion,
  ProviderJobLog,
  Transaction,
  User,
  UserEmailIntegration,
  sequelize,
} from '../models';
import { decryptSecret } from '../util/symmetricEncryption';
import {
  listMessageIds,
  fetchMessage,
  extractMessageBody,
  getHeader,
  refreshAccessToken,
} from './gmail';
import { parseInteracEmail } from './parsers/interac';
import {
  matchInteracCounterparty,
  type InteracEmailLite,
  type NamelessTxnLite,
} from '../import/matchInteracCounterparty';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import { logger } from '../observability/logger';

export const INTERAC_SYNC_PROVIDER = 'interac_counterparty_sync' as const;
export const INTERAC_SYNC_FUNCTION = 'sync' as const;

// ---------------------------------------------------------------------------
// In-flight lock — same pattern as counterpartyBackfill.ts
// ---------------------------------------------------------------------------

const inFlight = new Set<number>();

export function isInteracSyncRunning(householdId: number): boolean {
  return inFlight.has(householdId);
}

/** Test-only helper — clears any leftover in-flight markers between cases. */
export function _resetInteracSyncInFlightForTest(): void {
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface InteracSyncResult {
  processed: number;
  autoApplied: number;
  suggested: number;
  selfApplied: number;
  elapsedMs: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Token refresh (mirrors ensureFreshAccessToken in scanReceipts.ts)
// ---------------------------------------------------------------------------

async function ensureToken(integ: UserEmailIntegration): Promise<string> {
  const exp = integ.expiresAt ? integ.expiresAt.getTime() : 0;
  if (exp - Date.now() > 60_000) {
    return decryptSecret(integ.accessTokenEncrypted);
  }
  if (!integ.refreshTokenEncrypted) {
    throw new Error('Gmail token expired and no refresh token');
  }
  const r = await refreshAccessToken(decryptSecret(integ.refreshTokenEncrypted));
  return r.access_token;
}

// ---------------------------------------------------------------------------
// Gmail fetch (real path — injectable for tests)
// ---------------------------------------------------------------------------

export async function fetchInteracEmails(
  accessToken: string,
  sinceIso: string,
): Promise<InteracEmailLite[]> {
  const since = sinceIso.slice(0, 10).replace(/-/g, '/');
  const ids = await listMessageIds({
    accessToken,
    query: `from:payments.interac.ca after:${since}`,
    maxResults: 400,
  });
  const out: InteracEmailLite[] = [];
  for (const s of ids) {
    try {
      const full = await fetchMessage({ accessToken, messageId: s.id });
      const from = getHeader(full.payload, 'From') ?? '';
      const subject = getHeader(full.payload, 'Subject') ?? '';
      const body = extractMessageBody(full.payload);
      const parsed = parseInteracEmail(from, subject, body);
      if (!parsed) continue;
      out.push({
        ...parsed,
        emailDate: new Date(Number(full.internalDate)).toISOString().slice(0, 10),
        messageId: s.id,
      });
    } catch (e) {
      logger.warn(
        { err: e, messageId: s.id, module: 'interac_sync' },
        'interac_email_fetch_failed',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface RunInteracSyncOpts {
  householdId: number;
  userId: number;
  dryRun?: boolean;
  /**
   * Injectable fetch function. When provided, it is called with ('', '') and
   * the Gmail/token path is skipped entirely. Used by tests to avoid hitting
   * real Gmail.
   */
  fetchEmails?: (accessToken: string, sinceIso: string) => Promise<InteracEmailLite[]>;
}

export async function runInteracCounterpartySync(
  opts: RunInteracSyncOpts,
): Promise<InteracSyncResult> {
  const { householdId, userId, dryRun = false } = opts;

  if (inFlight.has(householdId)) {
    throw new Error('Interac sync already running for this household');
  }

  inFlight.add(householdId);
  const startedAt = Date.now();
  let processed = 0;
  let autoApplied = 0;
  let suggested = 0;
  let selfApplied = 0;
  let status: 'ok' | 'error' = 'ok';
  let errorMessage: string | null = null;

  try {
    const txns = await Transaction.findAll({
      where: {
        householdId,
        counterpartyContactId: { [Op.is]: null },
        merchantRaw: { [Op.iLike]: '%interac e-transfer%' },
      },
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['accountType', 'ownerUserId'],
          required: true,
          where: { accountType: ['checking', 'savings', 'cash'] },
        },
      ],
    });

    processed = txns.length;

    if (txns.length > 0) {
      const owner = await User.findByPk(userId);
      const ownerName = owner?.displayName ?? '';

      let emails: InteracEmailLite[] = [];

      if (opts.fetchEmails) {
        // Test stub path: call with dummy args, skip Gmail/token entirely.
        emails = await opts.fetchEmails('', '');
      } else {
        const integ = await UserEmailIntegration.findOne({
          where: { userId, provider: 'google' },
        });
        if (integ) {
          const token = await ensureToken(integ);
          // lexicographic sort is correct because dates are ISO YYYY-MM-DD strings
          const oldest = txns.map((t) => String(t.date)).sort()[0];
          const sinceIso = new Date(Date.parse(oldest) - 5 * 86_400_000).toISOString();
          emails = await fetchInteracEmails(token, sinceIso);
        } else {
          status = 'error';
          errorMessage = 'no_gmail_integration';
        }
      }

      if (status === 'ok') {
        const txnLites: NamelessTxnLite[] = txns.map((t) => ({
          id: t.id,
          amountCents: Math.round(Math.abs(Number(t.amount)) * 100),
          date: String(t.date).slice(0, 10),
        }));

        const { auto, review } = matchInteracCounterparty(emails, txnLites, ownerName);

        if (!dryRun) {
          for (const m of auto) {
            try {
              await sequelize.transaction(async (t) => {
                const patch: Record<string, unknown> = { counterpartyRaw: m.name };
                if (!m.isSelf) {
                  const contact = await findOrCreateContactByName(householdId, m.name, {
                    transaction: t,
                  });
                  patch.counterpartyContactId = contact.id;
                }
                const [n] = await Transaction.update(patch, {
                  where: { id: m.txnId, counterpartyContactId: { [Op.is]: null } },
                  transaction: t,
                });
                // autoApplied = real Contact links; selfApplied = self-funding raws (no Contact). Disjoint.
                if (n > 0) { if (m.isSelf) selfApplied++; else autoApplied++; }
              });
            } catch (e) {
              logger.error(
                { err: e, txnId: m.txnId, module: 'interac_sync' },
                'interac_auto_apply_failed',
              );
            }
          }

          for (const m of review) {
            const exists = await AiSuggestion.findOne({
              where: {
                householdId,
                transactionId: m.txnId,
                kind: 'counterparty_email_match',
                status: 'suggested',
              },
            });
            if (exists) continue;
            await AiSuggestion.create({
              householdId,
              userId,
              transactionId: m.txnId,
              kind: 'counterparty_email_match',
              status: 'suggested',
              inputSnapshot: { messageId: m.messageId, ref: m.ref },
              output: { name: m.name, isSelf: m.isSelf },
              finalSnapshot: null,
              model: 'deterministic',
              promptVersion: 'interac-email-match-v1',
            } as never);
            suggested++;
          }
        } else {
          // dryRun: count what would have happened without writing.
          autoApplied = auto.filter((m) => !m.isSelf).length;
          selfApplied = auto.filter((m) => m.isSelf).length;
          suggested = review.length;
        }
      }
    }
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, householdId, module: 'interac_sync' }, 'interac_sync_failed');
  } finally {
    inFlight.delete(householdId);
  }

  const elapsedMs = Date.now() - startedAt;
  const result: InteracSyncResult = {
    processed,
    autoApplied,
    suggested,
    selfApplied,
    elapsedMs,
    dryRun,
  };

  if (!dryRun) {
    await ProviderJobLog.create({
      provider: INTERAC_SYNC_PROVIDER,
      function: INTERAC_SYNC_FUNCTION,
      symbol: String(householdId),
      status,
      httpStatus: null,
      errorMessage:
        status === 'ok' ? JSON.stringify(result) : (errorMessage ?? JSON.stringify(result)),
      fetchedAt: new Date(),
    });
    logger.info(
      { householdId, ...result, status, module: 'interac_sync' },
      'interac_sync_completed',
    );
  }

  return result;
}
