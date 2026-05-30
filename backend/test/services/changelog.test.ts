import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  renderMarkdown,
  parseEntry,
  parseOverview,
  loadChangelog,
  userEntries,
  isUnread,
  entriesSince,
} from '../../src/services/changelog.js';

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(
    path.join(dir, 'overview.md'),
    `---\nkind: overview\nupdatedAt: 2026-05-30T01:22:39Z\n---\nCashflow tracks money.\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.51.md'),
    `---\nversion: v0.13.51\ntitle: Older\npublishedAt: 2026-05-28T20:33:35Z\naudience: user\n---\nOld stuff.\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.52.md'),
    `---\nversion: v0.13.52\ntitle: Newer\npublishedAt: 2026-05-30T01:22:39Z\naudience: user\n---\nNew stuff. <script>alert(1)</script>\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'v0.13.50.md'),
    `---\nversion: v0.13.50\ntitle: Chore\npublishedAt: 2026-05-27T00:00:00Z\naudience: operator\n---\nInternal.\n`,
  );
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderMarkdown strips script tags and event handlers', () => {
  const html = renderMarkdown('Hi <script>alert(1)</script> <a href="javascript:x" onclick="y">z</a>');
  assert.ok(!html.includes('<script'), 'script must be stripped');
  assert.ok(!html.includes('onclick'), 'event handler must be stripped');
  assert.ok(!html.includes('javascript:'), 'js: scheme must be stripped');
});

test('parseEntry returns null for the overview file', () => {
  const raw = `---\nkind: overview\n---\nx`;
  assert.equal(parseEntry(raw, 'overview.md'), null);
});

test('parseEntry maps fields and audience', () => {
  const e = parseEntry(`---\nversion: v1.0.0\ntitle: T\npublishedAt: 2026-01-01T00:00:00Z\naudience: operator\n---\nBody`, 'v1.0.0.md');
  assert.ok(e);
  assert.equal(e!.version, 'v1.0.0');
  assert.equal(e!.audience, 'operator');
  assert.ok(e!.html.includes('Body'));
});

test('loadChangelog sorts by publishedAt desc and separates overview', () => {
  const { entries, overview } = loadChangelog(dir);
  assert.ok(overview, 'overview parsed');
  assert.deepEqual(entries.map((e) => e.version), ['v0.13.52', 'v0.13.51', 'v0.13.50']);
});

test('userEntries filters out operator audience', () => {
  const { entries } = loadChangelog(dir);
  assert.deepEqual(userEntries(entries).map((e) => e.version), ['v0.13.52', 'v0.13.51']);
});

test('loadChangelog on a missing directory returns empty + null overview', () => {
  const res = loadChangelog(path.join(dir, 'does-not-exist'));
  assert.deepEqual(res.entries, []);
  assert.equal(res.overview, null);
});

test('isUnread: null last-seen → unread; equal/older → read for that entry', () => {
  const visible = userEntries(loadChangelog(dir).entries);
  const [newer, older] = visible; // v0.13.52, v0.13.51
  assert.equal(isUnread(newer, null, visible), true);
  assert.equal(isUnread(newer, 'v0.13.51', visible), true);  // newer than seen
  assert.equal(isUnread(older, 'v0.13.51', visible), false); // not newer than seen
});

test('entriesSince returns only entries newer than the given tag', () => {
  const visible = userEntries(loadChangelog(dir).entries);
  assert.deepEqual(entriesSince(visible, 'v0.13.51').map((e) => e.version), ['v0.13.52']);
  assert.deepEqual(entriesSince(visible, null).map((e) => e.version), ['v0.13.52', 'v0.13.51']);
});

test('loadChangelog output is sanitized (full path)', () => {
  const top = loadChangelog(dir).entries.find((e) => e.version === 'v0.13.52')!;
  assert.ok(!top.html.includes('<script'), 'loaded entry html must be sanitized');
});

test('parseEntry returns null when version or publishedAt is missing', () => {
  assert.equal(parseEntry('---\ntitle: T\naudience: user\n---\nBody', 'x.md'), null);
  assert.equal(parseEntry('---\nversion: v1.0.0\ntitle: T\n---\nBody', 'x.md'), null);
});
