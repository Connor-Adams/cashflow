import { Op } from 'sequelize';
import { defineJob } from '../registry';
import { ClientErrorEvent, ServerErrorEvent } from '../../models';

// 30 days: short enough to keep the tables small, long enough to debug month-old issues
const RETENTION_DAYS = 30;

defineJob({
  name: 'audit_buffer_trim',
  cronDefault: '0 4 * * *',
  enabledDefault: true,
  handler: async () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const [clientDeleted, serverDeleted] = await Promise.all([
      ClientErrorEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
      ServerErrorEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }),
    ]);
    return { deleted: clientDeleted + serverDeleted, clientDeleted, serverDeleted };
  },
});
