import { defineJob, runJobByName } from '../registry';
import { withAdvisoryLock } from '../pgLock';
import { drainPendingChunk } from '../../import/pdfImportProcessor';

defineJob({
  name: 'pdf_import_process',
  cronDefault: '* * * * *', // every minute; time-budgeted drain re-fires until empty
  enabledDefault: true,
  handler: async () => {
    const res = await withAdvisoryLock('pdf_import_process', () => drainPendingChunk());
    if (!res.acquired) return { summary: { skipped: 'locked' } };
    const r = res.value;
    if (r.pendingRemaining > 0) {
      // Lock released (withAdvisoryLock returned); continue draining without
      // waiting for the next minute. Reentrancy guard + lock prevent overlap.
      setTimeout(() => { void runJobByName('pdf_import_process').catch(() => {}); }, 250);
    }
    return { summary: r as unknown as Record<string, unknown> };
  },
});
