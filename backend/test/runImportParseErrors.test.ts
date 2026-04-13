import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendParseError,
  PARSE_ERRORS_MAX,
} from '../src/import/runImport';

test('appendParseError respects cap', () => {
  const bucket: { rowIndex: number; message: string }[] = [];
  for (let i = 0; i < PARSE_ERRORS_MAX + 15; i++) {
    appendParseError(bucket, i + 1, `err ${i}`);
  }
  assert.equal(bucket.length, PARSE_ERRORS_MAX);
  assert.equal(bucket[0].rowIndex, 1);
  assert.equal(bucket[PARSE_ERRORS_MAX - 1].rowIndex, PARSE_ERRORS_MAX);
});
