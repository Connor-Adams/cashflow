/**
 * scanReceipts — orchestrates a one-shot Gmail receipt-scan for a connected user.
 *
 * 1. Load + refresh the user's UserEmailIntegration row.
 * 2. Build a Gmail query for messages from receipt-vendor senders since the
 *    user's last_scan_at (or the last 30 days on first scan).
 * 3. For each result: fetch full body, AI-extract items, persist as
 *    ExternalOrder + items (skipping duplicates via the dedupeKey).
 * 4. Update last_scan_at; return per-message outcomes.
 *
 * The link-items pipeline stage matches the new orders to card transactions
 * on the next backfill / import.
 */
import {
  sequelize,
  ExternalOrder,
  ExternalOrderItem,
  ProcessedEmailMessage,
  ReceiptSenderAllowlist,
  UserEmailIntegration,
} from '../models';
import { classifySubject } from './subjectFilter';
import { tryDeterministicParse } from './parsers';
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';
import { decryptSecret, encryptSecret } from '../util/symmetricEncryption';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchMessage,
  fetchUserEmail,
  extractMessageBody,
  getHeader,
  listMessageIds,
  refreshAccessToken,
  revokeToken,
  isReauthRequiredError,
  GMAIL_READONLY_SCOPE,
  OPENID_EMAIL_SCOPE,
  type OauthTokenResponse,
} from './gmail';
import { extractReceiptFromText } from '../ai/extractReceiptItems';
import { defaultCurrency } from '../config/env';
import { uberVendorOverride } from './parsers/uber';
import { categorizeUberTrip } from '../ai/aiCategorizeUberTrip';
import { logger } from '../observability/logger';
import { runInteracCounterpartySync } from './interacCounterparty';
import { matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { categorizeAndApplyReceiptItems } from '../import/categorizeReceiptItems';

/**
 * Default sender allowlist baked into the app. Every household gets these
 * automatically. Per-household additions (via the receipt_sender_allowlist
 * table) are merged on top so the user can curate without code changes.
 */
export const DEFAULT_RECEIPT_SENDERS: Array<{ address: string; vendorHint: string; label: string }> = [
  // Apple
  { address: 'no_reply@email.apple.com', vendorHint: 'apple', label: 'Apple receipts' },
  { address: 'no-reply@apple.com', vendorHint: 'apple', label: 'Apple' },
  { address: 'noreply@apple.com', vendorHint: 'apple', label: 'Apple' },
  // Google
  { address: 'googleplay-noreply@google.com', vendorHint: 'google', label: 'Google Play' },
  { address: 'payments-noreply@google.com', vendorHint: 'google', label: 'Google Pay' },
  { address: 'no-reply@accounts.google.com', vendorHint: 'google', label: 'Google account' },
  // Amazon (US/CA/UK/DE)
  { address: 'auto-confirm@amazon.com', vendorHint: 'amazon', label: 'Amazon (order)' },
  { address: 'auto-confirm@amazon.ca', vendorHint: 'amazon', label: 'Amazon.ca (order)' },
  { address: 'auto-confirm@amazon.co.uk', vendorHint: 'amazon', label: 'Amazon.co.uk (order)' },
  { address: 'auto-confirm@amazon.de', vendorHint: 'amazon', label: 'Amazon.de (order)' },
  { address: 'ship-confirm@amazon.com', vendorHint: 'amazon', label: 'Amazon (shipped)' },
  { address: 'ship-confirm@amazon.ca', vendorHint: 'amazon', label: 'Amazon.ca (shipped)' },
  { address: 'order-update@amazon.com', vendorHint: 'amazon', label: 'Amazon (order update)' },
  { address: 'order-update@amazon.ca', vendorHint: 'amazon', label: 'Amazon.ca (order update)' },
  { address: 'digital-no-reply@amazon.com', vendorHint: 'amazon', label: 'Amazon digital / Kindle' },
  { address: 'no-reply@primevideo.com', vendorHint: 'amazon', label: 'Prime Video' },
  { address: 'noreply@audible.com', vendorHint: 'amazon', label: 'Audible' },
  // Rides / food
  { address: 'receipts@uber.com', vendorHint: 'uber', label: 'Uber receipts' },
  { address: 'noreply@uber.com', vendorHint: 'uber', label: 'Uber' },
  { address: 'no-reply@uber.com', vendorHint: 'uber', label: 'Uber' },
  { address: 'no-reply@lyftmail.com', vendorHint: 'other', label: 'Lyft' },
  { address: 'no-reply@doordash.com', vendorHint: 'other', label: 'DoorDash' },
  { address: 'no-reply@grubhub.com', vendorHint: 'other', label: 'Grubhub' },
  { address: 'noreply@skipthedishes.com', vendorHint: 'other', label: 'SkipTheDishes' },
  // Subscriptions / streaming
  { address: 'info@netflix.com', vendorHint: 'other', label: 'Netflix' },
  { address: 'no-reply@spotify.com', vendorHint: 'other', label: 'Spotify' },
];

/** Returns the effective allowlist for a household (defaults + DB additions),
 *  filtered to enabled entries. Addresses are normalised to lowercase. */
export async function getEffectiveAllowlist(householdId: number): Promise<string[]> {
  const customRows = await ReceiptSenderAllowlist.findAll({
    where: { householdId, enabled: true },
    attributes: ['emailAddress'],
  });
  const merged = new Set<string>();
  for (const d of DEFAULT_RECEIPT_SENDERS) merged.add(d.address.toLowerCase());
  for (const r of customRows) merged.add(r.emailAddress.toLowerCase());
  return [...merged];
}

export function buildGmailQuery(opts: { sinceDate: Date | null; senders: string[] }): string {
  if (opts.senders.length === 0) return 'in:nowhere'; // safe empty query
  const fromClause = opts.senders.map((addr) => `from:${addr}`).join(' OR ');
  const parts = [`(${fromClause})`];
  if (opts.sinceDate) {
    const y = opts.sinceDate.getUTCFullYear();
    const m = String(opts.sinceDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(opts.sinceDate.getUTCDate()).padStart(2, '0');
    parts.push(`after:${y}/${m}/${d}`);
  }
  return parts.join(' ');
}

/** Receipt-ish subject keywords for the discovery net. Quoted phrases are kept
 *  as Gmail exact-phrase matches. */
export const DISCOVERY_SUBJECT_KEYWORDS = [
  'receipt',
  'invoice',
  '"order confirmation"',
  '"your order"',
  '"payment received"',
  '"tax invoice"',
];

/** Builds the broad discovery query: Gmail's purchases category OR receipt
 *  subject keywords (OR PDF-attachment invoices when enabled), minus senders we
 *  already handle, within the date window. */
export function buildDiscoveryQuery(opts: {
  sinceDate: Date | null;
  excludeSenders: string[];
  includePdfAttachments?: boolean;
}): string {
  const signals = [
    'category:purchases',
    `subject:(${DISCOVERY_SUBJECT_KEYWORDS.join(' OR ')})`,
  ];
  if (opts.includePdfAttachments) {
    signals.push('(has:attachment filename:pdf subject:(invoice OR receipt))');
  }
  const parts = [`(${signals.join(' OR ')})`];
  for (const addr of opts.excludeSenders) {
    parts.push(`-from:${addr}`);
  }
  if (opts.sinceDate) {
    const y = opts.sinceDate.getUTCFullYear();
    const m = String(opts.sinceDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(opts.sinceDate.getUTCDate()).padStart(2, '0');
    parts.push(`after:${y}/${m}/${d}`);
  }
  return parts.join(' ');
}

/** Senders the household explicitly dismissed during discovery — excluded from
 *  future discovery queries so they never re-surface. */
export async function getDismissedSenders(householdId: number): Promise<string[]> {
  const rows = await ReceiptSenderAllowlist.findAll({
    where: { householdId, status: 'dismissed' },
    attributes: ['emailAddress'],
  });
  return rows.map((r) => r.emailAddress.toLowerCase());
}

/** Everything the discovery query should exclude: senders the fast scan already
 *  covers (enabled allowlist + baked-in defaults) plus dismissed senders. */
export async function getDiscoveryExclusions(householdId: number): Promise<string[]> {
  const [allowed, dismissed] = await Promise.all([
    getEffectiveAllowlist(householdId),
    getDismissedSenders(householdId),
  ]);
  return [...new Set([...allowed, ...dismissed])];
}

export async function ensureFreshAccessToken(integ: UserEmailIntegration): Promise<string> {
  const now = Date.now();
  const expiresAt = integ.expiresAt ? integ.expiresAt.getTime() : 0;
  const expiringSoon = expiresAt - now < 60_000;
  if (!expiringSoon) {
    return decryptSecret(integ.accessTokenEncrypted);
  }
  if (!integ.refreshTokenEncrypted) {
    throw new Error('Access token expired and no refresh token available');
  }
  try {
    const refreshed = await refreshAccessToken(decryptSecret(integ.refreshTokenEncrypted));
    await applyTokenResponseTo(integ, refreshed, { keepRefreshIfMissing: true });
    return refreshed.access_token;
  } catch (err) {
    await markReauthIfRevoked(integ, err);
    throw err;
  }
}

/**
 * If `err` means the Google grant is dead (revoked/expired refresh token),
 * mark the integration as needing reconnection so the UI can prompt a re-link
 * instead of silently failing every scan. Returns true if it flagged the row.
 * Any other error is left untouched (it may be transient).
 */
export async function markReauthIfRevoked(
  integ: UserEmailIntegration,
  err: unknown,
): Promise<boolean> {
  if (!isReauthRequiredError(err)) return false;
  integ.set({
    status: 'reconnect_needed',
    statusReason: 'Google access was revoked or expired. Reconnect Gmail to resume scanning.',
  });
  await integ.save();
  return true;
}

/**
 * Mutates the integration row with the new tokens and saves.
 * Google sometimes omits refresh_token on refresh — keepRefreshIfMissing
 * preserves the existing refresh token in that case.
 */
async function applyTokenResponseTo(
  integ: UserEmailIntegration,
  resp: OauthTokenResponse,
  opts: { keepRefreshIfMissing: boolean },
): Promise<void> {
  integ.set({
    accessTokenEncrypted: encryptSecret(resp.access_token),
    expiresAt: new Date(Date.now() + Math.max(60, resp.expires_in - 30) * 1000),
    scopes: resp.scope ?? integ.scopes ?? null,
    status: 'connected',
    statusReason: null,
  });
  if (resp.refresh_token) {
    integ.set({ refreshTokenEncrypted: encryptSecret(resp.refresh_token) });
  } else if (!opts.keepRefreshIfMissing) {
    integ.set({ refreshTokenEncrypted: null });
  }
  await integ.save();
}

export interface ConnectionDetails {
  authUrl: string;
  state: string;
}

export function initiateConnection(userId: number): ConnectionDetails {
  // State binds the callback to the user. We keep it simple: base64 of
  // `${userId}:${randomBytes16}`. The route validates by parsing userId out
  // of state and confirming the caller's session matches.
  const nonce = require('crypto').randomBytes(12).toString('hex');
  const state = Buffer.from(`${userId}:${nonce}`).toString('base64url');
  return { authUrl: buildAuthUrl(state), state };
}

export function parseStateUserId(state: string): number | null {
  try {
    const raw = Buffer.from(state, 'base64url').toString('utf8');
    const [idPart] = raw.split(':');
    const id = Number(idPart);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function completeConnection(opts: {
  userId: number;
  code: string;
}): Promise<UserEmailIntegration> {
  const tokens = await exchangeCodeForTokens(opts.code);
  const accountEmail = await fetchUserEmail(tokens.access_token);

  const existing = await UserEmailIntegration.findOne({
    where: { userId: opts.userId, provider: 'google' },
  });

  if (existing) {
    await applyTokenResponseTo(existing, tokens, { keepRefreshIfMissing: true });
    existing.set({ accountEmail });
    await existing.save();
    return existing;
  }

  const created = await UserEmailIntegration.create({
    userId: opts.userId,
    provider: 'google',
    accountEmail,
    accessTokenEncrypted: encryptSecret(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    expiresAt: new Date(Date.now() + Math.max(60, tokens.expires_in - 30) * 1000),
    scopes: tokens.scope ?? `${GMAIL_READONLY_SCOPE} ${OPENID_EMAIL_SCOPE}`,
    lastScanAt: null,
    lastHistoryId: null,
    status: 'connected',
    statusReason: null,
  });
  return created;
}

export async function disconnect(userId: number): Promise<void> {
  const integ = await UserEmailIntegration.findOne({
    where: { userId, provider: 'google' },
  });
  if (!integ) return;
  // Best-effort revocation; we still delete the row even if revoke fails.
  try {
    const refresh = integ.refreshTokenEncrypted
      ? decryptSecret(integ.refreshTokenEncrypted)
      : null;
    if (refresh) await revokeToken(refresh);
  } catch (err) {
    logger.warn({
      userId,
      message: err instanceof Error ? err.message : String(err),
    }, 'gmail_revoke_failed');
  }
  await integ.destroy();
}

/**
 * ExternalOrder.currency is NOT NULL, but AI extraction legitimately returns
 * currency null when the receipt shows none. Default to the app's currency
 * (CAD), never a hardcoded 'USD': a fabricated USD makes the receipt matcher's
 * -40 currency penalty kill otherwise-perfect matches against CAD card rows.
 */
export function receiptCurrencyOrDefault(extractedCurrency: string | null | undefined): string {
  return extractedCurrency ?? defaultCurrency;
}

export interface ScanResultMessage {
  messageId: string;
  from: string | null;
  subject: string | null;
  internalDate: string | null;
  /** 'extracted' | 'duplicate' | 'skipped_already_seen' | 'filtered_subject' | 'no_items' | 'extraction_failed' */
  status: string;
  /** 'apple' | 'google' | 'amazon' | 'ai' | null */
  parser: string | null;
  orderId: number | null;
  orderCreated: boolean;
  itemsCount: number;
  vendor: string;
  total: number | null;
  error: string | null;
}

export interface ScanResult {
  scannedMessages: number;
  createdOrders: number;
  duplicateOrders: number;
  filteredBySubject: number;
  skippedAlreadySeen: number;
  failedExtractions: number;
  byParser: Record<string, number>;
  aiExtractions: number;
  messages: ScanResultMessage[];
  query: string;
  sinceDate: string | null;
}

export type ScanPhaseEvent =
  | { phase: 'listing'; fetched: number; hasMore: boolean }
  | { phase: 'processing-start'; total: number }
  | { phase: 'processed'; index: number; total: number };

export interface ScanCallbacks {
  /** Coarse phase markers — "listing", "processing started", per-message done. */
  onPhase?: (e: ScanPhaseEvent) => void;
  /** Per-message result the moment it's processed. */
  onMessage?: (msg: ScanResultMessage) => void;
}

export async function scanInbox(
  opts: {
    userId: number;
    householdId: number | null;
    maxMessages?: number;
    /** Override sinceDate manually (e.g. one-time backfill of more history). */
    sinceDateOverride?: Date | null;
  },
  callbacks: ScanCallbacks = {},
): Promise<ScanResult> {
  const integ = await UserEmailIntegration.findOne({
    where: { userId: opts.userId, provider: 'google' },
  });
  if (!integ) {
    const err = new Error('Gmail is not connected for this user') as Error & {
      status?: number;
    };
    err.status = 404;
    throw err;
  }

  const accessToken = await ensureFreshAccessToken(integ);

  const sinceDate =
    opts.sinceDateOverride !== undefined
      ? opts.sinceDateOverride
      : integ.lastScanAt ?? new Date(Date.now() - 30 * 86_400_000);
  const senders =
    opts.householdId != null
      ? await getEffectiveAllowlist(opts.householdId)
      : DEFAULT_RECEIPT_SENDERS.map((d) => d.address);
  const query = buildGmailQuery({ sinceDate, senders });

  const summaries = await listMessageIds({
    accessToken,
    query,
    maxResults: opts.maxMessages ?? 50,
    onPage: ({ fetched, hasMore }) =>
      callbacks.onPhase?.({ phase: 'listing', fetched, hasMore }),
  });
  callbacks.onPhase?.({ phase: 'processing-start', total: summaries.length });

  // Pre-load the set of already-seen Gmail message IDs for this household so
  // we can skip them before fetching/extracting.
  const seen = new Set<string>();
  if (opts.householdId != null && summaries.length > 0) {
    const seenRows = await ProcessedEmailMessage.findAll({
      where: {
        householdId: opts.householdId,
        provider: 'google',
        messageId: summaries.map((s) => s.id),
      },
      attributes: ['messageId'],
    });
    for (const r of seenRows) seen.add(r.messageId);
  }

  const results: ScanResultMessage[] = [];
  let created = 0;
  let dupes = 0;
  let failed = 0;
  let filteredBySubject = 0;
  let skippedAlreadySeen = 0;
  let aiExtractions = 0;
  const byParser: Record<string, number> = {};

  async function recordProcessed(opts2: {
    messageId: string;
    status: string;
    parser?: string | null;
    externalOrderId?: number | null;
    errorMessage?: string | null;
    subject: string | null;
    fromAddr: string | null;
  }): Promise<void> {
    if (opts.householdId == null) return;
    try {
      await ProcessedEmailMessage.upsert({
        householdId: opts.householdId,
        provider: 'google',
        messageId: opts2.messageId,
        status: opts2.status,
        parser: opts2.parser ?? null,
        externalOrderId: opts2.externalOrderId ?? null,
        errorMessage: opts2.errorMessage ?? null,
        subject: opts2.subject?.slice(0, 512) ?? null,
        fromAddr: opts2.fromAddr?.slice(0, 256) ?? null,
        scannedAt: new Date(),
      } as never);
    } catch (err) {
      // Don't let the audit-log fail bring down a scan.
      logger.warn({
        messageId: opts2.messageId,
        error: err instanceof Error ? err.message : String(err),
      }, 'processed_email_log_failed');
    }
  }

  /** Process a single Gmail message ID and return its result. All counter
   *  bookkeeping (skipped/filtered/created/...) and DB writes happen here;
   *  the outer loop only handles streaming callbacks.
   */
  async function processOne(summary: { id: string }): Promise<ScanResultMessage> {
    const result: ScanResultMessage = {
      messageId: summary.id,
      from: null,
      subject: null,
      internalDate: null,
      status: 'unknown',
      parser: null,
      orderId: null,
      orderCreated: false,
      itemsCount: 0,
      vendor: 'other',
      total: null,
      error: null,
    };

    if (seen.has(summary.id)) {
      result.status = 'skipped_already_seen';
      skippedAlreadySeen++;
      return result;
    }

    try {
      const full = await fetchMessage({ accessToken, messageId: summary.id });
      result.from = getHeader(full.payload, 'From');
      result.subject = getHeader(full.payload, 'Subject');
      result.internalDate = full.internalDate;

      const subjectVerdict = classifySubject(result.subject);
      if (subjectVerdict.decision === 'block') {
        result.status = 'filtered_subject';
        result.error = subjectVerdict.reason;
        filteredBySubject++;
        await recordProcessed({
          messageId: summary.id,
          status: 'filtered_subject',
          parser: null,
          subject: result.subject,
          fromAddr: result.from,
        });
        return result;
      }

      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        result.status = 'extraction_failed';
        result.error = 'empty body';
        failed++;
        await recordProcessed({
          messageId: summary.id,
          status: 'extraction_failed',
          parser: null,
          errorMessage: 'empty body',
          subject: result.subject,
          fromAddr: result.from,
        });
        return result;
      }

      // 1) Try the cheap deterministic vendor parser first.
      let extracted: ExtractedReceiptOrder | null = null;
      let parser: string = 'ai';
      const detResult = tryDeterministicParse({
        fromAddress: result.from,
        subject: result.subject,
        body,
      });
      if (detResult.ok) {
        extracted = detResult.order;
        parser = detResult.parser;
      } else {
        // 2) Fall back to AI extraction.
        extracted = await extractReceiptFromText(body);
        parser = 'ai';
        aiExtractions++;
      }

      // Uber rides and Uber Eats both arrive from uber.com but the AI returns
      // vendor 'other'. The sender is authoritative for the vendor family;
      // subject/body picks ride vs eats.
      const uberVendor = uberVendorOverride(result.from, result.subject, body);
      if (uberVendor) {
        extracted.vendor = uberVendor;
      }

      result.parser = parser;
      byParser[parser] = (byParser[parser] ?? 0) + 1;
      result.vendor = extracted.vendor;
      result.total = extracted.total;
      result.itemsCount = extracted.items.length;

      if (extracted.total == null && extracted.items.length === 0) {
        result.status = 'no_items';
        result.error = 'no items extracted';
        failed++;
        await recordProcessed({
          messageId: summary.id,
          status: 'no_items',
          parser,
          errorMessage: 'no items extracted',
          subject: result.subject,
          fromAddr: result.from,
        });
        return result;
      }

      // For Uber rides, infer business-use from trip context and stamp it on
      // the single synthetic trip item so it propagates via linkItemsStage.
      if (extracted.vendor === 'uber' && extracted.trip && extracted.items[0]) {
        try {
          const cat = await categorizeUberTrip(extracted.trip);
          extracted.items[0].inferredCategory = cat.category;
          extracted.items[0].businessUsePercent = cat.businessUsePercent;
        } catch (err) {
          logger.warn(
            { messageId: summary.id, error: err instanceof Error ? err.message : String(err) },
            'uber_trip_categorize_failed',
          );
        }
      }

      const dedupeKey = [
        extracted.vendor,
        extracted.orderId || '',
        extracted.orderDate || '',
        extracted.total != null ? String(extracted.total) : '',
        String(extracted.items.length),
        // Gmail message id makes the key absolutely unique across users while
        // preserving cross-message dedup when the same receipt arrives twice.
        summary.id,
      ].join(':');

      await sequelize.transaction(async (t) => {
        const [order, createdOrder] = await ExternalOrder.findOrCreate({
          where:
            opts.householdId != null
              ? { householdId: opts.householdId, dedupeKey }
              : { dedupeKey },
          defaults: {
            householdId: opts.householdId,
            createdByUserId: opts.userId,
            vendor: extracted!.vendor,
            vendorOrderId: extracted!.orderId,
            dedupeKey,
            orderDate: extracted!.orderDate,
            shipmentDate: null,
            subtotal: null,
            tax: null,
            shipping: null,
            total: extracted!.total != null ? String(extracted!.total) : null,
            currency: receiptCurrencyOrDefault(extracted!.currency),
            paymentLast4: extracted!.paymentLast4,
            source: `gmail-scan:${parser}`,
            rawPayload: { extracted, gmailMessageId: summary.id, parser, trip: extracted!.trip ?? null } as unknown,
          } as never,
          transaction: t,
        });
        result.orderId = order.id;
        result.orderCreated = createdOrder;
        if (createdOrder && extracted!.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            extracted!.items.map((it) => ({
              externalOrderId: order.id,
              title: it.title,
              quantity: it.quantity,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: it.inferredCategory,
              businessUsePercent: it.businessUsePercent != null ? String(it.businessUsePercent) : null,
              confidence: null,
              itemNumber: it.vendorItemId ?? null,
              rawPayload: it as unknown,
            })) as never[],
            { transaction: t },
          );
        }
      });

      result.status = result.orderCreated ? 'extracted' : 'duplicate';
      if (result.orderCreated) created++;
      else dupes++;

      // Auto-link new orders to card transactions. Runs AFTER the DB transaction
      // commits so the order row is visible. A match failure must never fail the scan.
      if (result.orderCreated === true && result.orderId != null && opts.householdId != null) {
        try {
          await matchReceiptOrderToTransactions({
            externalOrderId: result.orderId,
            householdId: opts.householdId,
          });
        } catch (err) {
          logger.warn({ err, orderId: result.orderId }, 'gmail_scan_match_failed');
        }
        // Categorize regardless of match outcome: items need a confidence (so the
        // SP1 review-clear bar can pass) even if no transaction matched yet. It is
        // itself best-effort (never throws) and runs last so its recompute sees the
        // accepted link (if match made one) plus the confidences it just wrote.
        await categorizeAndApplyReceiptItems({ householdId: opts.householdId, orderId: result.orderId });
      }

      await recordProcessed({
        messageId: summary.id,
        status: result.status,
        parser,
        externalOrderId: result.orderId,
        subject: result.subject,
        fromAddr: result.from,
      });
    } catch (err) {
      result.status = 'extraction_failed';
      result.error = err instanceof Error ? err.message : String(err);
      failed++;
      await recordProcessed({
        messageId: summary.id,
        status: 'extraction_failed',
        parser: result.parser,
        errorMessage: result.error,
        subject: result.subject,
        fromAddr: result.from,
      });
    }
    return result;
  }

  for (let i = 0; i < summaries.length; i++) {
    const result = await processOne(summaries[i]);
    results.push(result);
    callbacks.onMessage?.(result);
    callbacks.onPhase?.({ phase: 'processed', index: i + 1, total: summaries.length });
  }

  integ.set({ lastScanAt: new Date() });
  await integ.save();

  // Best-effort: after the receipt pass, refresh e-transfer counterparty names
  // from Interac emails. Never let it fail the scan.
  if (opts.householdId != null) {
    try {
      await runInteracCounterpartySync({ householdId: opts.householdId, userId: opts.userId });
    } catch (e) {
      logger.warn({ err: e, module: 'interac_sync' }, 'post_scan_interac_sync_failed');
    }
  }

  return {
    scannedMessages: summaries.length,
    createdOrders: created,
    duplicateOrders: dupes,
    filteredBySubject,
    skippedAlreadySeen,
    failedExtractions: failed,
    byParser,
    aiExtractions,
    messages: results,
    query,
    sinceDate: sinceDate ? sinceDate.toISOString() : null,
  };
}
