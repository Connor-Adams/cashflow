/**
 * Data export expiry cleanup cron job (issue #302).
 *
 * Runs daily at 3 AM. Finds DataExport rows where expires_at < now and
 * status is 'ready', deletes the archive file from disk, then marks the
 * row as 'failed' (with an error message indicating expiry) so the UI can
 * show a meaningful state rather than a dangling "ready" row.
 */
import { Op } from 'sequelize';
import { defineJob } from '../registry';
import { DataExport } from '../../models';
import { deleteArchiveFile } from '../../services/dataExportArchive';
import { logger } from '../../observability/logger';

defineJob({
  name: 'data_export_cleanup',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => {
    const expired = await DataExport.findAll({
      where: {
        status: 'ready',
        expiresAt: { [Op.lt]: new Date() },
      },
    });

    let deleted = 0;
    let errors = 0;

    for (const row of expired) {
      try {
        if (row.storageKey) {
          deleteArchiveFile(row.storageKey);
        }
        await row.update({
          status: 'failed',
          errorMessage: 'Export expired and has been deleted.',
          storageKey: null,
        });
        deleted++;
      } catch (err) {
        errors++;
        logger.error({ err, exportId: row.id }, 'data_export_cleanup_row_failed');
      }
    }

    logger.info({ deleted, errors }, 'data_export_cleanup_done');
    return { summary: { deleted, errors } };
  },
});
