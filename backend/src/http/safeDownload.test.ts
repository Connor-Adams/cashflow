import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeDownloadContentType } from './safeDownload';

// Stored-XSS hardening (issue #819): user-uploaded bytes must never be served
// with a content-type a browser will render/execute same-origin. Images are
// inert when sniffed, so they keep their real type; everything else collapses
// to application/octet-stream so an attacker-declared text/html (or text/plain
// containing markup) cannot be rendered as a document.

test('image content-types pass through unchanged', () => {
  for (const mime of [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
  ]) {
    assert.equal(safeDownloadContentType(mime), mime);
  }
});

test('text/html is neutralized to application/octet-stream', () => {
  assert.equal(safeDownloadContentType('text/html'), 'application/octet-stream');
});

test('text/plain is neutralized (can contain markup browsers sniff)', () => {
  assert.equal(safeDownloadContentType('text/plain'), 'application/octet-stream');
});

test('svg images are neutralized (scriptable XML, not inert)', () => {
  assert.equal(
    safeDownloadContentType('image/svg+xml'),
    'application/octet-stream',
  );
});

test('pdf and office docs collapse to octet-stream', () => {
  for (const mime of [
    'application/pdf',
    'application/json',
    'text/csv',
    'application/msword',
  ]) {
    assert.equal(safeDownloadContentType(mime), 'application/octet-stream');
  }
});

test('mixed-case and whitespace are normalized before matching', () => {
  assert.equal(safeDownloadContentType('  IMAGE/PNG  '), 'image/png');
});

test('empty / nullish input falls back to octet-stream', () => {
  assert.equal(safeDownloadContentType(''), 'application/octet-stream');
  assert.equal(
    safeDownloadContentType(undefined as unknown as string),
    'application/octet-stream',
  );
});
