import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPdfParts, extractPdfReceiptText, MAX_PDFS } from './pdfAttachments';

const pdfPart = (attachmentId: string, filename: string | null, mimeType: string, size = 1000) => ({
  mimeType, filename: filename ?? undefined, body: { size, attachmentId },
});

test('collectPdfParts finds application/pdf and .pdf parts with an attachmentId, nested', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: 'aGk' } },
      pdfPart('att-1', 'invoice.pdf', 'application/pdf'),
      { mimeType: 'multipart/alternative', parts: [pdfPart('att-2', 'RECEIPT.PDF', 'application/octet-stream')] },
      // No attachmentId -> ignored
      { mimeType: 'application/pdf', filename: 'x.pdf', body: { size: 10 } },
      // Not a pdf -> ignored
      pdfPart('att-3', 'photo.jpg', 'image/jpeg'),
    ],
  };
  const refs = collectPdfParts(payload);
  assert.deepEqual(refs.map((r) => r.attachmentId), ['att-1', 'att-2']);
});

test('extractPdfReceiptText concatenates text across PDFs and caps at MAX_PDFS', async () => {
  const payload = {
    parts: Array.from({ length: 5 }, (_, i) => pdfPart(`a${i}`, `f${i}.pdf`, 'application/pdf')),
  };
  const fetched: string[] = [];
  const text = await extractPdfReceiptText(
    { accessToken: 'tok', messageId: 'm1', payload },
    {
      fetchAttachment: async ({ attachmentId }) => { fetched.push(attachmentId); return Buffer.from(attachmentId); },
      extractPdfLines: async (buf) => [{ text: `line-${buf.toString()}` }],
    },
  );
  assert.equal(fetched.length, MAX_PDFS); // capped
  assert.match(text, /line-a0/);
  assert.match(text, /line-a2/);
});

test('extractPdfReceiptText skips oversize attachments', async () => {
  const payload = { parts: [{ mimeType: 'application/pdf', filename: 'big.pdf', body: { size: 99 * 1024 * 1024, attachmentId: 'big' } }] };
  let called = false;
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload },
    { fetchAttachment: async () => { called = true; return Buffer.from(''); }, extractPdfLines: async () => [{ text: 'x' }] },
  );
  assert.equal(called, false);
  assert.equal(text, '');
});

test('extractPdfReceiptText returns empty string when there are no PDFs', async () => {
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload: { parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }] } },
    { fetchAttachment: async () => Buffer.from(''), extractPdfLines: async () => [{ text: 'x' }] },
  );
  assert.equal(text, '');
});

test('extractPdfReceiptText skips a PDF whose fetch throws, keeps the others', async () => {
  const payload = { parts: [pdfPart('bad', 'a.pdf', 'application/pdf'), pdfPart('good', 'b.pdf', 'application/pdf')] };
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload },
    {
      fetchAttachment: async ({ attachmentId }) => { if (attachmentId === 'bad') throw new Error('boom'); return Buffer.from('ok'); },
      extractPdfLines: async () => [{ text: 'good-text' }],
    },
  );
  assert.match(text, /good-text/);
});
