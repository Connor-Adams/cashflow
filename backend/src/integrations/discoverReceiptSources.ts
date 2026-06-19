/**
 * Discovery pass — the "smart" counterpart to scanInbox. Casts a broad Gmail
 * net (purchases category + receipt subject keywords, minus known senders) and
 * splits results by confidence:
 *   HIGH → create the ExternalOrder + auto-learn the sender (enabled).
 *   LOW  → upsert a 'suggested' sender row; write NO order.
 * Reuses scanInbox's parse pipeline; the fast scan path is untouched.
 *
 * Gmail access (list/fetch) and AI extraction are injectable via `deps` so the
 * orchestrator is unit-testable on SQLite without network.
 */
// Order-persist block intentionally parallels scanReceipts.ts; folding the two
// is a follow-up, not this task's scope.
// fallow-ignore-file code-duplication
import {
  sequelize,
  ExternalOrder,
  ExternalOrderItem,
  ProcessedEmailMessage,
  ReceiptSenderAllowlist,
  UserEmailIntegration,
} from '../models';
import {
  buildDiscoveryQuery,
  getDiscoveryExclusions,
  receiptCurrencyOrDefault,
  ensureFreshAccessToken,
} from './scanReceipts';
import {
  fetchMessage as realFetchMessage,
  listMessageIds as realListMessageIds,
  extractMessageBody,
  getHeader,
} from './gmail';
import { classifySubject } from './subjectFilter';
import { tryDeterministicParse } from './parsers';
import { extractReceiptFromText } from '../ai/extractReceiptItems';
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';
import { isPurchasesLabel, classifyDiscoveryConfidence } from './discoveryConfidence';
import { hasMatchingTransaction, matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { categorizeAndApplyReceiptItems } from '../import/categorizeReceiptItems';
import { upsertSenderSuggestion, parseEmailAddress } from './receiptSenderSuggestions';
import { logger } from '../observability/logger';

export interface DiscoveryDeps {
  listMessageIds: typeof realListMessageIds;
  fetchMessage: typeof realFetchMessage;
  extractFromText: (body: string) => Promise<ExtractedReceiptOrder>;
}

export interface DiscoveryResultMessage {
  messageId: string;
  from: string | null;
  subject: string | null;
  /** 'auto_learned' | 'suggested_sender' | 'duplicate' | 'skipped_already_seen' | 'filtered_subject' | 'no_items' | 'extraction_failed' */
  status: string;
  parser: string | null;
  vendor: string;
  total: number | null;
  orderId: number | null;
  confidence: 'high' | 'low' | null;
  error: string | null;
}

export interface DiscoveryResult {
  scannedMessages: number;
  autoIngested: number;
  suggestionsAdded: number;
  suggestionsUpdated: number;
  skippedAlreadySeen: number;
  filteredBySubject: number;
  failed: number;
  messages: DiscoveryResultMessage[];
  query: string;
  sinceDate: string | null;
}

export type DiscoveryPhaseEvent =
  | { phase: 'listing'; fetched: number; hasMore: boolean }
  | { phase: 'processing-start'; total: number }
  | { phase: 'processed'; index: number; total: number };

export interface DiscoveryCallbacks {
  onPhase?: (e: DiscoveryPhaseEvent) => void;
  onMessage?: (m: DiscoveryResultMessage) => void;
}

export async function discoverReceiptSources(
  opts: {
    userId: number;
    householdId: number;
    maxMessages?: number;
    sinceDateOverride?: Date | null;
  },
  callbacks: DiscoveryCallbacks = {},
  deps: Partial<DiscoveryDeps> = {},
): Promise<DiscoveryResult> {
  const listMessageIds = deps.listMessageIds ?? realListMessageIds;
  const fetchMessage = deps.fetchMessage ?? realFetchMessage;
  const extractFromText = deps.extractFromText ?? extractReceiptFromText;

  const integ = await UserEmailIntegration.findOne({
    where: { userId: opts.userId, provider: 'google' },
  });
  if (!integ) {
    const err = new Error('Gmail is not connected for this user') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const accessToken = await ensureFreshAccessToken(integ);

  const sinceDate =
    opts.sinceDateOverride !== undefined
      ? opts.sinceDateOverride
      : new Date(Date.now() - 30 * 86_400_000);
  const excludeSenders = await getDiscoveryExclusions(opts.householdId);
  const query = buildDiscoveryQuery({ sinceDate, excludeSenders });

  const summaries = await listMessageIds({
    accessToken,
    query,
    maxResults: opts.maxMessages ?? 300,
    onPage: ({ fetched, hasMore }) => callbacks.onPhase?.({ phase: 'listing', fetched, hasMore }),
  });
  callbacks.onPhase?.({ phase: 'processing-start', total: summaries.length });

  const seen = new Set<string>();
  if (summaries.length > 0) {
    const seenRows = await ProcessedEmailMessage.findAll({
      where: { householdId: opts.householdId, provider: 'google', messageId: summaries.map((s) => s.id) },
      attributes: ['messageId'],
    });
    for (const r of seenRows) seen.add(r.messageId);
  }

  const results: DiscoveryResultMessage[] = [];
  let autoIngested = 0;
  let suggestionsAdded = 0;
  let suggestionsUpdated = 0;
  let skippedAlreadySeen = 0;
  let filteredBySubject = 0;
  let failed = 0;

  async function recordProcessed(p: {
    messageId: string;
    status: string;
    parser?: string | null;
    externalOrderId?: number | null;
    errorMessage?: string | null;
    subject: string | null;
    fromAddr: string | null;
  }): Promise<void> {
    try {
      await ProcessedEmailMessage.upsert({
        householdId: opts.householdId,
        provider: 'google',
        messageId: p.messageId,
        status: p.status,
        parser: p.parser ?? null,
        externalOrderId: p.externalOrderId ?? null,
        errorMessage: p.errorMessage ?? null,
        subject: p.subject?.slice(0, 512) ?? null,
        fromAddr: p.fromAddr?.slice(0, 256) ?? null,
        scannedAt: new Date(),
      } as never);
    } catch (err) {
      logger.warn(
        { messageId: p.messageId, error: err instanceof Error ? err.message : String(err) },
        'discovery_processed_log_failed',
      );
    }
  }

  async function persistHighConfidenceOrder(args: {
    extracted: ExtractedReceiptOrder;
    parser: string;
    gmailMessageId: string;
  }): Promise<number> {
    const { extracted, parser, gmailMessageId } = args;
    const dedupeKey = [
      extracted.vendor,
      extracted.orderId || '',
      extracted.orderDate || '',
      extracted.total != null ? String(extracted.total) : '',
      String(extracted.items.length),
      gmailMessageId,
    ].join(':');
    let orderId = 0;
    await sequelize.transaction(async (t) => {
      const [order, createdOrder] = await ExternalOrder.findOrCreate({
        where: { householdId: opts.householdId, dedupeKey },
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
          currency: receiptCurrencyOrDefault(extracted.currency),
          paymentLast4: extracted.paymentLast4,
          source: `gmail-discovery:${parser}`,
          rawPayload: { extracted, gmailMessageId, parser } as unknown,
        } as never,
        transaction: t,
      });
      orderId = order.id;
      if (createdOrder && extracted.items.length > 0) {
        await ExternalOrderItem.bulkCreate(
          extracted.items.map((it) => ({
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
    return orderId;
  }

  async function processOne(summary: { id: string }): Promise<DiscoveryResultMessage> {
    const r: DiscoveryResultMessage = {
      messageId: summary.id, from: null, subject: null, status: 'unknown',
      parser: null, vendor: 'other', total: null, orderId: null, confidence: null, error: null,
    };
    if (seen.has(summary.id)) {
      r.status = 'skipped_already_seen';
      skippedAlreadySeen++;
      return r;
    }
    try {
      const full = await fetchMessage({ accessToken, messageId: summary.id });
      r.from = getHeader(full.payload, 'From');
      r.subject = getHeader(full.payload, 'Subject');

      if (classifySubject(r.subject).decision === 'block') {
        r.status = 'filtered_subject';
        filteredBySubject++;
        await recordProcessed({ messageId: summary.id, status: 'filtered_subject', subject: r.subject, fromAddr: r.from });
        return r;
      }

      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        r.status = 'extraction_failed';
        r.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', errorMessage: 'empty body', subject: r.subject, fromAddr: r.from });
        return r;
      }

      let extracted: ExtractedReceiptOrder | null = null;
      let parser = 'ai';
      const det = tryDeterministicParse({ fromAddress: r.from, subject: r.subject, body });
      if (det.ok) {
        extracted = det.order;
        parser = det.parser;
      } else {
        extracted = await extractFromText(body);
        parser = 'ai';
      }
      r.parser = parser;
      r.vendor = extracted.vendor;
      r.total = extracted.total;

      const hasCleanExtract = extracted.total != null && extracted.items.length > 0;
      if (!hasCleanExtract && parser === 'ai') {
        // Nothing usable and no deterministic signal — surface the sender so the
        // user can decide, but write no order.
        r.status = 'no_items';
        failed++;
        await upsertSenderSuggestion({ householdId: opts.householdId, fromAddr: r.from, subject: r.subject });
        await recordProcessed({ messageId: summary.id, status: 'no_items', parser, subject: r.subject, fromAddr: r.from });
        return r;
      }

      const amountMatched =
        parser === 'ai'
          ? await hasMatchingTransaction({
              householdId: opts.householdId,
              vendor: extracted.vendor,
              total: extracted.total,
              currency: receiptCurrencyOrDefault(extracted.currency),
              orderDate: extracted.orderDate,
              paymentLast4: extracted.paymentLast4,
            })
          : false;

      const confidence = classifyDiscoveryConfidence({
        parser,
        isPurchases: isPurchasesLabel(full.labelIds),
        hasCleanExtract,
        amountMatched,
      });
      r.confidence = confidence;

      if (confidence === 'high') {
        const orderId = await persistHighConfidenceOrder({ extracted, parser, gmailMessageId: summary.id });
        r.orderId = orderId;
        r.status = 'auto_learned';
        autoIngested++;
        // Auto-learn the sender so future fast scans cover it.
        await upsertSenderSuggestion({ householdId: opts.householdId, fromAddr: r.from, subject: r.subject });
        await promoteLearnedSender(opts.householdId, r.from);
        try {
          await matchReceiptOrderToTransactions({ externalOrderId: orderId, householdId: opts.householdId });
        } catch (err) {
          logger.warn({ err, orderId }, 'discovery_match_failed');
        }
        try {
          await categorizeAndApplyReceiptItems({ householdId: opts.householdId, orderId });
        } catch (err) {
          logger.warn({ err, orderId }, 'discovery_categorize_failed');
        }
        await recordProcessed({ messageId: summary.id, status: 'auto_learned', parser, externalOrderId: orderId, subject: r.subject, fromAddr: r.from });
      } else {
        const before = await suggestionExists(opts.householdId, r.from);
        await upsertSenderSuggestion({ householdId: opts.householdId, fromAddr: r.from, subject: r.subject });
        if (before) suggestionsUpdated++;
        else suggestionsAdded++;
        r.status = 'suggested_sender';
        await recordProcessed({ messageId: summary.id, status: 'suggested_sender', parser, subject: r.subject, fromAddr: r.from });
      }
    } catch (err) {
      r.status = 'extraction_failed';
      r.error = err instanceof Error ? err.message : String(err);
      failed++;
      await recordProcessed({ messageId: summary.id, status: 'extraction_failed', parser: r.parser, errorMessage: r.error, subject: r.subject, fromAddr: r.from });
    }
    return r;
  }

  for (let i = 0; i < summaries.length; i++) {
    const result = await processOne(summaries[i]);
    results.push(result);
    callbacks.onMessage?.(result);
    callbacks.onPhase?.({ phase: 'processed', index: i + 1, total: summaries.length });
  }

  return {
    scannedMessages: summaries.length,
    autoIngested,
    suggestionsAdded,
    suggestionsUpdated,
    skippedAlreadySeen,
    filteredBySubject,
    failed,
    messages: results,
    query,
    sinceDate: sinceDate ? sinceDate.toISOString() : null,
  };
}

async function suggestionExists(householdId: number, fromAddr: string | null): Promise<boolean> {
  const addr = parseEmailAddress(fromAddr);
  if (!addr) return false;
  const row = await ReceiptSenderAllowlist.findOne({
    where: { householdId, emailAddress: addr, status: 'suggested' },
    attributes: ['id'],
  });
  return row != null;
}

/** Flip the just-learned sender row to enabled so the fast scan picks it up. */
async function promoteLearnedSender(householdId: number, fromAddr: string | null): Promise<void> {
  const addr = parseEmailAddress(fromAddr);
  if (!addr) return;
  const row = await ReceiptSenderAllowlist.findOne({ where: { householdId, emailAddress: addr } });
  if (row && row.status !== 'dismissed') {
    row.set({ status: 'enabled', enabled: true, source: 'discovery' });
    await row.save();
  }
}
