/**
 * `runUserDataExport(exportId)` — invoked from `POST /api/me/export`
 * immediately after the queued row is created (issue #302).
 *
 * This is deliberately NOT a scheduled cron job (no `defineJob`) — it is an
 * on-demand background task dispatched per user request. Keeping it outside
 * the cron framework avoids the advisory-lock single-instance constraint that
 * would prevent two users from running exports concurrently.
 *
 * Lifecycle:
 *  1. Marks the row `running`.
 *  2. Resolves the user's household_id via HouseholdMember.
 *  3. Calls `buildDataExportArchive()` to write the ZIP.
 *  4. On success: marks `ready`, records storage_key, byte_size, ready_at,
 *     expires_at, fires `data_export.ready` notification.
 *  5. On failure: marks `failed`, records error_message, fires
 *     `data_export.failed` notification.
 */
import { DataExport } from '../../models/DataExport';
import { HouseholdMember } from '../../models/HouseholdMember';
import { buildDataExportArchive } from '../../services/dataExportArchive';
import { enqueueNotification } from '../../notifications/index';
import { EXPORT_TTL_MS } from '../../config/dataExports';
import { logger } from '../../observability/logger';

export async function runUserDataExport(exportId: number): Promise<void> {
  const exportRow = await DataExport.findByPk(exportId);
  if (!exportRow) {
    logger.warn({ exportId }, 'user_data_export: row not found');
    return;
  }

  const userId = exportRow.userId;

  // Mark running
  await exportRow.update({ status: 'running' });

  try {
    const membership = await HouseholdMember.findOne({
      where: { userId },
      attributes: ['householdId'],
    });
    if (!membership) {
      throw new Error(`No household found for user ${userId}`);
    }
    const householdId = membership.householdId;

    const { storageKey, byteSize } = await buildDataExportArchive(
      userId,
      householdId,
      exportId,
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS);

    await exportRow.update({
      status: 'ready',
      storageKey,
      byteSize,
      readyAt: now,
      expiresAt,
      errorMessage: null,
    });

    // Notification — non-fatal
    try {
      await enqueueNotification(userId, 'data_export.ready', {
        title: 'Your data export is ready',
        body: 'Your full data backup is ready to download. It expires in 7 days.',
        severity: 'info',
        dataJson: { exportId },
      });
    } catch (notifyErr) {
      logger.warn({ err: notifyErr, exportId, userId }, 'data_export_notify_ready_failed');
    }

    logger.info({ exportId, userId, byteSize }, 'user_data_export_success');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, exportId, userId }, 'user_data_export_failed');

    await exportRow.update({
      status: 'failed',
      errorMessage: message,
    });

    // Notification — non-fatal
    try {
      await enqueueNotification(userId, 'data_export.failed', {
        title: 'Data export failed',
        body: `Your data export could not be completed: ${message}`,
        severity: 'warn',
        dataJson: { exportId },
      });
    } catch (notifyErr) {
      logger.warn({ err: notifyErr, exportId, userId }, 'data_export_notify_failed');
    }
  }
}
