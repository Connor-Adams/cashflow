import { defineJob, runJobByName } from '../registry';
import { drainPendingChunk } from '../../import/pdfImportProcessor';
import { logger } from '../../observability/logger';

defineJob({
  name: 'pdf_import_process',
  cronDefault: '* * * * *',
  enabledDefault: true,
  handler: async () => {
    const r = await drainPendingChunk();
    if (r.pendingRemaining > 0) {
      // Lock (held by the runner) is released once this handler returns; the
      // delayed re-fire continues draining without waiting for the next minute.
      setTimeout(() => {
        void runJobByName('pdf_import_process').catch((err) => {
          logger.warn({ err }, 'pdf_import_process_refire_failed');
        });
      }, 250);
    }
    return { summary: r as unknown as Record<string, unknown> };
  },
});
