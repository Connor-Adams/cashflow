#!/usr/bin/env tsx
/**
 * One-time reprocess of email-sourced orders that have no `order_date`
 * (docs/superpowers/specs/2026-09-10-amazon-email-matching-design.md, Part 1e).
 *
 * Amazon confirmation emails state a DELIVERY date ("Arriving Thursday,
 * September 4"), not an order date, so both the deterministic parser and the AI
 * extractor correctly returned null and 140 of 141 email-sourced orders ended up
 * with no `order_date` at all -- which makes them unmatchable, since
 * `scoreAmazonOrderMatch` needs amount + date. `scanInbox` now falls back to
 * Gmail's own `internalDate`, but that only helps messages scanned AFTER the
 * fix. This re-fetches the already-seen ones.
 *
 * Raw bodies are not retained, but the Gmail message id is -- in
 * `ExternalOrder.rawPayload.gmailMessageId`. This collects those ids and hands
 * them to `scanInbox` as `forceReprocessMessageIds`, which bypasses the
 * `ProcessedEmailMessage` skip for exactly those messages. The existing order
 * row is then backfilled in place: NULL fields only, never overwriting a value
 * a user may have corrected.
 *
 * The Gmail LIST window matters. `scanInbox` deletes the forced ids from its
 * `seen` set, but the message must still be RETURNED by the list query, whose
 * window is `sinceDateOverride ?? lastScanAt ?? now-30d`. Reprocessing orders
 * from 2025 therefore needs a wide `--since-days`; the default here is 10 years.
 * Run it against the default 30-day window and you get `created: 0` and it looks
 * like success.
 *
 * Usage:
 *   cd backend && npx tsx scripts/reprocess-dateless-email-orders.ts --dry-run
 *   cd backend && npx tsx scripts/reprocess-dateless-email-orders.ts --apply
 *
 * Flags:
 *   --dry-run          List the orders that would be reprocessed. DEFAULT.
 *   --apply            Actually re-fetch and reprocess.
 *   --since-days=N     Gmail list window. Default 3650.
 *   --max-messages=N   Cap passed to scanInbox. Default 5000.
 */
import { Op } from 'sequelize';
import { sequelize, ExternalOrder, HouseholdMember, UserEmailIntegration } from '../src/models';
import { scanInbox } from '../src/integrations/scanReceipts';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numArg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const apply = flag('apply');
  const sinceDays = numArg('since-days', 3650);
  const maxMessages = numArg('max-messages', 5000);

  const dateless = await ExternalOrder.findAll({
    where: { orderDate: null, source: { [Op.like]: 'gmail%' } },
    order: [['id', 'ASC']],
  });

  const byMessageId = new Map<string, number[]>();
  for (const order of dateless) {
    const raw = order.rawPayload as { gmailMessageId?: unknown } | null;
    const id = typeof raw?.gmailMessageId === 'string' ? raw.gmailMessageId : null;
    if (id == null) continue;
    const ids = byMessageId.get(id) ?? [];
    ids.push(order.id);
    byMessageId.set(id, ids);
  }

  const messageIds = Array.from(byMessageId.keys());
  console.log(
    `${dateless.length} email-sourced order(s) with no order_date; ` +
      `${messageIds.length} distinct Gmail message id(s) recoverable.`,
  );
  const orphans = dateless.length - Array.from(byMessageId.values()).flat().length;
  if (orphans > 0) {
    console.log(`  ${orphans} order(s) carry no gmailMessageId and cannot be reprocessed.`);
  }

  if (!apply) {
    for (const [messageId, orderIds] of byMessageId) {
      console.log(`  would reprocess ${messageId} -> order(s) ${orderIds.join(', ')}`);
    }
    console.log('\nDry run — nothing fetched or written. Re-run with --apply.');
    return;
  }

  const integrations = await UserEmailIntegration.findAll({
    where: { provider: 'google', status: 'connected' },
  });
  if (integrations.length === 0) {
    console.error('No connected Google integration. Reconnect Gmail first.');
    process.exitCode = 1;
    return;
  }

  for (const integration of integrations) {
    const membership = await HouseholdMember.findOne({ where: { userId: integration.userId } });
    if (membership == null) continue;

    const result = await scanInbox({
      userId: integration.userId,
      householdId: membership.householdId,
      maxMessages,
      sinceDateOverride: new Date(Date.now() - sinceDays * 86_400_000),
      forceReprocessMessageIds: messageIds,
    });

    console.log(
      `integration ${integration.id}: scanned ${result.results?.length ?? 0}, ` +
        `created ${result.created}, skipped-already-seen ${result.skippedAlreadySeen}`,
    );
  }

  const stillDateless = await ExternalOrder.count({
    where: { orderDate: null, source: { [Op.like]: 'gmail%' } },
  });
  console.log(
    `\nAfter reprocess: ${stillDateless} of ${dateless.length} still have no order_date.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
