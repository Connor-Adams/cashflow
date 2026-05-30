import { Op } from 'sequelize';
import { defineJob } from '../registry';
import { ClientErrorEvent, ServerErrorEvent } from '../../models';

const CLIENT_ERROR_CAP = 5_000;
const SERVER_ERROR_CAP = 2_000;

async function trimTable(
  model: typeof ClientErrorEvent | typeof ServerErrorEvent,
  cap: number,
): Promise<number> {
  const total = await model.count();
  if (total <= cap) return 0;
  const excess = total - cap;
  const oldest = await model.findAll({
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
    limit: excess,
  });
  if (oldest.length === 0) return 0;
  const ids = oldest.map((r) => r.id);
  return model.destroy({ where: { id: { [Op.in]: ids } } });
}

defineJob({
  name: 'audit_buffer_trim',
  cronDefault: '42 3 * * *',
  enabledDefault: true,
  handler: async () => {
    const [clientDeleted, serverDeleted] = await Promise.all([
      trimTable(ClientErrorEvent, CLIENT_ERROR_CAP),
      trimTable(ServerErrorEvent, SERVER_ERROR_CAP),
    ]);
    return { clientDeleted, serverDeleted };
  },
});
