import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBuffer } from './gmail';

test('base64UrlToBuffer decodes base64url (URL-safe alphabet) to raw bytes', () => {
  // "%PDF-1." in base64url. Standard base64 would be "JVBERi0xLg==".
  const b64url = 'JVBERi0xLg';
  const buf = base64UrlToBuffer(b64url);
  assert.equal(buf.toString('latin1'), '%PDF-1.');
});

test('base64UrlToBuffer handles the URL-safe chars - and _', () => {
  // bytes 0xfb 0xff 0xbf -> standard base64 "+/+/", base64url "-_-_"
  const buf = base64UrlToBuffer('-_-_');
  assert.deepEqual([...buf], [0xfb, 0xff, 0xbf]);
});
