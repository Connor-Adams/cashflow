import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { kickPdfImportProcessor } from './import';
import { logger } from '../observability/logger';

afterEach(() => {
  mock.restoreAll();
});

// AC #9: when the processor kick rejects, the failure is logged as
// `pdf_import_kick_failed` with the batchId, instead of being swallowed.
test('kickPdfImportProcessor: logs pdf_import_kick_failed when the kick rejects', async () => {
  const errorSpy = mock.method(logger, 'error', () => {});
  const boom = new Error('registry unavailable');
  const failingRunner = () => Promise.reject(boom);

  // Must resolve (never reject) — the kick is fire-and-forget.
  await kickPdfImportProcessor('batch-123', failingRunner);

  assert.equal(errorSpy.mock.callCount(), 1);
  const [fields, message] = errorSpy.mock.calls[0].arguments as [
    { err: unknown; batchId: string },
    string,
  ];
  assert.equal(message, 'pdf_import_kick_failed');
  assert.equal(fields.batchId, 'batch-123');
  assert.equal(fields.err, boom);
});

// AC #10 companion: on a successful kick, nothing is logged as a failure.
test('kickPdfImportProcessor: does not log a failure on a successful kick', async () => {
  const errorSpy = mock.method(logger, 'error', () => {});
  const okRunner = () => Promise.resolve({ ok: true });

  await kickPdfImportProcessor('batch-456', okRunner);

  assert.equal(errorSpy.mock.callCount(), 0);
});
