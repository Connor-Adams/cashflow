import { defineJob } from '../registry';
import { Op } from 'sequelize';
import { DataExport } from '../../models';
import { deleteExportFile } from '../../services/dataExportArchive';

defineJob({
  name: 'data_export_cleanup',
  cronDefault: '0 7 * * *',
  enabledDefault: true,
  handler: async () => {
    const expired = await DataExport.findAll({
      where: {
        expiresAt: { [Op.lt]: new Date() },
        status: 'ready',
      },
    });
    let deleted = 0;
    for (const row of expired) {
      if (row.storageKey) {
        await deleteExportFile(row.storageKey);
      }
      await row.update({ status: 'failed', errorMessage: 'Expired and purged.' });
      deleted += 1;
    }
    return { summary: { deleted } };
  },
});
