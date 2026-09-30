import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importReceiptPdfsBulk, type ReceiptFile, type ImportOneResult } from './importReceiptPdfs';

function pdf(name: string): ReceiptFile {
  return { originalname: name, mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') };
}

/** Per-file worker stub. The real one parses + persists + matches; the batching
 *  logic under test must not care which. */
function worker(
  behaviour: Record<string, 'created' | 'duplicate' | Error>,
): (f: ReceiptFile) => Promise<ImportOneResult> {
  return async (f) => {
    const b = behaviour[f.originalname];
    if (b instanceof Error) throw b;
    return {
      created: b === 'created',
      parserId: 'costco_till_receipt',
      orderId: Object.keys(behaviour).indexOf(f.originalname) + 100,
      warnings: [],
      linksCreated: b === 'created' ? 2 : 0,
      linksUpdated: 0,
    };
  };
}

test('one failing file does not abort the batch', async () => {
  const files = [pdf('a.pdf'), pdf('bad.pdf'), pdf('c.pdf')];
  const summary = await importReceiptPdfsBulk(
    files,
    worker({ 'a.pdf': 'created', 'bad.pdf': new Error('no receipt parser matched this PDF'), 'c.pdf': 'created' }),
  );

  assert.equal(summary.results.length, 3);
  assert.deepEqual(summary.results.map((r) => r.status), ['imported', 'failed', 'imported']);
  assert.equal(summary.results[1].error, 'no receipt parser matched this PDF');
  assert.equal(summary.imported, 2);
  assert.equal(summary.failed, 1);
});

test('a re-uploaded receipt is reported as a duplicate, not an import', async () => {
  const summary = await importReceiptPdfsBulk(
    [pdf('new.pdf'), pdf('again.pdf')],
    worker({ 'new.pdf': 'created', 'again.pdf': 'duplicate' }),
  );

  assert.deepEqual(summary.results.map((r) => r.status), ['imported', 'duplicate']);
  assert.equal(summary.imported, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.total, 2);
});

test('results keep upload order so each one maps back to its filename', async () => {
  const names = ['z.pdf', 'm.pdf', 'a.pdf'];
  const summary = await importReceiptPdfsBulk(
    names.map(pdf),
    worker({ 'z.pdf': 'created', 'm.pdf': 'created', 'a.pdf': 'created' }),
  );
  assert.deepEqual(summary.results.map((r) => r.filename), names);
});

test('a non-PDF fails only its own entry', async () => {
  const files: ReceiptFile[] = [
    pdf('good.pdf'),
    { originalname: 'notes.txt', mimetype: 'text/plain', buffer: Buffer.from('hello') },
  ];
  const summary = await importReceiptPdfsBulk(files, worker({ 'good.pdf': 'created' }));

  assert.equal(summary.results[0].status, 'imported');
  assert.equal(summary.results[1].status, 'failed');
  assert.match(summary.results[1].error ?? '', /pdf/i);
  assert.equal(summary.imported, 1);
  assert.equal(summary.failed, 1);
});

test('an empty upload is a valid empty batch, not an error', async () => {
  const summary = await importReceiptPdfsBulk([], worker({}));
  assert.deepEqual(summary, { total: 0, imported: 0, duplicates: 0, failed: 0, results: [] });
});

test('files are processed sequentially so dedupe of two identical receipts is deterministic', async () => {
  const order: string[] = [];
  const summary = await importReceiptPdfsBulk(
    [pdf('1.pdf'), pdf('2.pdf'), pdf('3.pdf')],
    async (f) => {
      order.push(`start:${f.originalname}`);
      await new Promise((r) => setTimeout(r, f.originalname === '1.pdf' ? 15 : 0));
      order.push(`end:${f.originalname}`);
      return { created: true, parserId: 'costco_till_receipt', orderId: 1, warnings: [], linksCreated: 0, linksUpdated: 0 };
    },
  );
  assert.equal(summary.imported, 3);
  assert.deepEqual(order, [
    'start:1.pdf', 'end:1.pdf',
    'start:2.pdf', 'end:2.pdf',
    'start:3.pdf', 'end:3.pdf',
  ]);
});
