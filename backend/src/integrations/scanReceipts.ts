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
import { sequelize, ExternalOrder, ExternalOrderItem, UserEmailIntegration } from '../models';
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
  GMAIL_READONLY_SCOPE,
  OPENID_EMAIL_SCOPE,
  type OauthTokenResponse,
} from './gmail';
import { extractReceiptFromText } from '../ai/extractReceiptItems';
import { logger } from '../observability/logger';

/** Email addresses we'll fetch and try to extract receipts from. */
export const RECEIPT_SENDER_ALLOWLIST: string[] = [
  // Apple
  'no_reply@email.apple.com',
  'no-reply@apple.com',
  'noreply@apple.com',
  // Google
  'googleplay-noreply@google.com',
  'payments-noreply@google.com',
  'no-reply@accounts.google.com',
  // Amazon
  'auto-confirm@amazon.com',
  'auto-confirm@amazon.ca',
  'ship-confirm@amazon.com',
  'ship-confirm@amazon.ca',
  'order-update@amazon.com',
  // Common food / ride / general receipts
  'receipts@uber.com',
  'no-reply@uber.com',
  'no-reply@doordash.com',
  'no-reply@grubhub.com',
];

function buildGmailQuery(opts: { sinceDate: Date | null }): string {
  const fromClause = RECEIPT_SENDER_ALLOWLIST.map((addr) => `from:${addr}`).join(' OR ');
  const parts = [`(${fromClause})`];
  if (opts.sinceDate) {
    const y = opts.sinceDate.getUTCFullYear();
    const m = String(opts.sinceDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(opts.sinceDate.getUTCDate()).padStart(2, '0');
    parts.push(`after:${y}/${m}/${d}`);
  }
  return parts.join(' ');
}

async function ensureFreshAccessToken(integ: UserEmailIntegration): Promise<string> {
  const now = Date.now();
  const expiresAt = integ.expiresAt ? integ.expiresAt.getTime() : 0;
  const expiringSoon = expiresAt - now < 60_000;
  if (!expiringSoon) {
    return decryptSecret(integ.accessTokenEncrypted);
  }
  if (!integ.refreshTokenEncrypted) {
    throw new Error('Access token expired and no refresh token available');
  }
  const refreshed = await refreshAccessToken(decryptSecret(integ.refreshTokenEncrypted));
  await applyTokenResponseTo(integ, refreshed, { keepRefreshIfMissing: true });
  return refreshed.access_token;
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
    logger.warn('gmail_revoke_failed', {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  await integ.destroy();
}

export interface ScanResultMessage {
  messageId: string;
  from: string | null;
  subject: string | null;
  internalDate: string | null;
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
  failedExtractions: number;
  messages: ScanResultMessage[];
  query: string;
  sinceDate: string | null;
}

export async function scanInbox(opts: {
  userId: number;
  householdId: number | null;
  maxMessages?: number;
  /** Override sinceDate manually (e.g. one-time backfill of more history). */
  sinceDateOverride?: Date | null;
}): Promise<ScanResult> {
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
  const query = buildGmailQuery({ sinceDate });

  const summaries = await listMessageIds({
    accessToken,
    query,
    maxResults: opts.maxMessages ?? 50,
  });

  const results: ScanResultMessage[] = [];
  let created = 0;
  let dupes = 0;
  let failed = 0;

  for (const summary of summaries) {
    const result: ScanResultMessage = {
      messageId: summary.id,
      from: null,
      subject: null,
      internalDate: null,
      orderId: null,
      orderCreated: false,
      itemsCount: 0,
      vendor: 'other',
      total: null,
      error: null,
    };
    try {
      const full = await fetchMessage({ accessToken, messageId: summary.id });
      result.from = getHeader(full.payload, 'From');
      result.subject = getHeader(full.payload, 'Subject');
      result.internalDate = full.internalDate;

      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        result.error = 'empty body';
        failed++;
        results.push(result);
        continue;
      }
      const extracted = await extractReceiptFromText(body);
      result.vendor = extracted.vendor;
      result.total = extracted.total;
      result.itemsCount = extracted.items.length;

      if (extracted.total == null && extracted.items.length === 0) {
        result.error = 'no items extracted';
        failed++;
        results.push(result);
        continue;
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
            vendor: extracted.vendor,
            vendorOrderId: extracted.orderId,
            dedupeKey,
            orderDate: extracted.orderDate,
            shipmentDate: null,
            subtotal: null,
            tax: null,
            shipping: null,
            total: extracted.total != null ? String(extracted.total) : null,
            currency: extracted.currency ?? 'USD',
            paymentLast4: extracted.paymentLast4,
            source: 'gmail-scan',
            rawPayload: { extracted, gmailMessageId: summary.id } as unknown,
          } as never,
          transaction: t,
        });
        result.orderId = order.id;
        result.orderCreated = createdOrder;
        if (createdOrder && extracted.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            extracted.items.map((it) => ({
              externalOrderId: order.id,
              title: it.title,
              quantity: it.quantity,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: it.inferredCategory,
              businessUsePercent: null,
              confidence: null,
              rawPayload: it as unknown,
            })) as never[],
            { transaction: t },
          );
        }
      });

      if (result.orderCreated) created++;
      else dupes++;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      failed++;
    }
    results.push(result);
  }

  integ.set({ lastScanAt: new Date() });
  await integ.save();

  return {
    scannedMessages: summaries.length,
    createdOrders: created,
    duplicateOrders: dupes,
    failedExtractions: failed,
    messages: results,
    query,
    sinceDate: sinceDate ? sinceDate.toISOString() : null,
  };
}
