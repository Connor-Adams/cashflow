/**
 * `dataExportCleanup` — daily cron (issue #302, AC #8).
 *
 * Runs once per day. For each data_exports row where `expires_at < NOW()`:
 *  1. Deletes the physical ZIP file from disk (if it exists).
 *  2. Nullifies `storage_key` so re-download attempts see "expired" rather
 *     than a dangling reference.
 *
 * The row itself is kept (with status preserved) so the user can see the
 * history in the Settings → Data tab.
 */
import { Op } from 'sequelize';
import { defineJob } from '../registry';
import { DataExport } from '../../models/DataExport';
import { deleteExportFile } from '../../services/dataExportArchive';
import { logger } from '../../observability/logger';

defineJob({
  name: 'data_export_cleanup',
  cronDefault: '30 3 * * *',
  enabledDefault: true,
  handler: async () => {
    const now = new Date();

    const expired = await DataExport.findAll({
      where: {
        expiresAt: { [Op.lt]: now },
        storageKey: { [Op.ne]: null },
      },
      attributes: ['id', 'userId', 'storageKey'],
    });

    let deleted = 0;
    let errors = 0;

    for (const row of expired) {
      try {
        if (row.storageKey) {
          await deleteExportFile(row.storageKey);
        }
        await row.update({ storageKey: null });
        deleted++;
      } catch (err) {
        errors++;
        logger.error({ err, exportId: row.id, userId: row.userId }, 'data_export_cleanup_row_error');
      }
    }

    logger.info({ scanned: expired.length, deleted, errors }, 'data_export_cleanup_done');
    return { summary: { scanned: expired.length, deleted, errors } };
  },
});
