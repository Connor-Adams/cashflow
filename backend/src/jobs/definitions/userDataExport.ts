/**
 * On-demand data export job (issue #302).
 *
 * NOT a cron job — triggered by POST /api/me/export which creates a
 * DataExport row and then calls runDataExport(exportId) asynchronously.
 *
 * Lifecycle: queued → running → ready | failed
 */
import { DataExport, HouseholdMember } from '../../models';
import { buildExportArchive } from '../../services/dataExportArchive';
import { logger } from '../../observability/logger';

const EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function runDataExport(exportId: number): Promise<void> {
  const row = await DataExport.findByPk(exportId);
  if (!row) {
    logger.warn({ exportId }, 'data_export_not_found');
    return;
  }

  await row.update({ status: 'running' });

  try {
    const userId = Number(row.userId);
    const exportId = Number(row.id);

    // Resolve the user's current household (if any).
    const membership = await HouseholdMember.findOne({
      where: { userId },
      order: [['id', 'ASC']],
    });
    const householdId = membership ? Number(membership.householdId) : null;

    const { storagePath, byteSize } = await buildExportArchive(
      userId,
      householdId,
      exportId,
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRES_IN_MS);

    await row.update({
      status: 'ready',
      storageKey: storagePath,
      byteSize,
      readyAt: now,
      expiresAt,
    });

    logger.info({ exportId: row.id, byteSize }, 'data_export_ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, exportId }, 'data_export_failed');
    await row.update({ status: 'failed', errorMessage: message.slice(0, 4000) });
  }
}
