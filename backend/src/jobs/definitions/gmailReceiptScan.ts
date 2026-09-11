/**
 * Scheduled Gmail receipt scan.
 *
 * Gmail was the only ingestion channel reachable solely by hand — POST
 * /api/email/scan/google — while fourteen other jobs ran on cron. Receipts
 * therefore arrived only when someone remembered to click, and the Amazon
 * order corpus went stale. The runner (jobs/runner.ts) supplies ticking,
 * per-job DB-backed config, and pg advisory locking, so this only supplies a
 * handler; the lock also prevents overlap with a manual scan.
 *
 * `UserEmailIntegration` is per-USER and carries no `householdId` — `scanInbox`
 * needs one, so it is resolved through `HouseholdMember` the same way
 * `auth/middleware.ts` does it (first membership by id, oldest wins).
 *
 * Amazon matching is run once per household that was actually scanned this
 * run — not once per integration — since two mailboxes in the same household
 * would otherwise have their orders matched against transactions twice.
 * Scanning and matching are each wrapped per-unit so one household's failure
 * (a revoked token, a Gmail API error, a bad match) can't abort the run for
 * everyone else.
 */
import { defineJob } from '../registry';
import { logger } from '../../observability/logger';
import { HouseholdMember, UserEmailIntegration } from '../../models';
import { scanInbox } from '../../integrations/scanReceipts';
import { runAmazonMatching } from '../../amazon/matcher';

export interface GmailReceiptScanDeps {
  scanInbox: typeof scanInbox;
  runAmazonMatching: typeof runAmazonMatching;
}

const defaultDeps: GmailReceiptScanDeps = { scanInbox, runAmazonMatching };

export async function runGmailReceiptScan(deps: GmailReceiptScanDeps = defaultDeps) {
  const integrations = await UserEmailIntegration.findAll({
    where: { provider: 'google', status: 'connected' },
  });

  let scannedMessages = 0;
  let created = 0;
  let autoAccepted = 0;
  let errors = 0;
  const scannedHouseholds = new Set<number>();

  for (const integration of integrations) {
    try {
      const membership = await HouseholdMember.findOne({
        where: { userId: integration.userId },
        order: [['id', 'ASC']],
      });
      if (membership == null) continue;

      const result = await deps.scanInbox({
        userId: integration.userId,
        householdId: membership.householdId,
        maxMessages: 200,
      });
      scannedMessages += result.scannedMessages;
      created += result.createdOrders;
      scannedHouseholds.add(membership.householdId);
    } catch (err) {
      errors += 1;
      logger.error({ err, integrationId: integration.id }, 'gmail_receipt_scan_failed');
    }
  }

  for (const householdId of scannedHouseholds) {
    try {
      const match = await deps.runAmazonMatching({ householdId });
      autoAccepted += match.autoAccepted;
    } catch (err) {
      errors += 1;
      logger.error({ err, householdId }, 'gmail_receipt_scan_matching_failed');
    }
  }

  const summary = {
    integrations: integrations.length,
    scanned: scannedMessages,
    created,
    autoAccepted,
    errors,
  };
  logger.info(summary, 'gmail_receipt_scan_run');
  return { summary };
}

defineJob({
  name: 'gmail_receipt_scan',
  cronDefault: '0 5 * * *',
  enabledDefault: true,
  handler: () => runGmailReceiptScan(),
});
