import { defineJob } from '../registry';
import { withAdvisoryLock } from '../pgLock';
import { drainPendingChunk } from '../../import/pdfImportProcessor';

defineJob({
  name: 'pdf_import_process',
  cronDefault: '* * * * *', // every minute; drains a bounded chunk per tick
  enabledDefault: true,
  handler: async () => {
    const res = await withAdvisoryLock('pdf_import_process', () => drainPendingChunk({ chunk: 12 }));
    if (!res.acquired) return { summary: { skipped: 'locked' } };
    return { summary: res.value as unknown as Record<string, unknown> };
  },
});
