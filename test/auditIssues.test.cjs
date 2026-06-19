const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFindings,
  diffFindings,
  buildIssueTitle,
  buildIssueBody,
} = require('../scripts/audit-issues.cjs');

// Issue #386 — code-audit findings on `main` become one `chore` issue each.
// These tests pin the pure logic: extracting findings from a fallow dead-code
// report, diffing against the committed baseline, and rendering issue title/body
// with an exact file:line blob URL and rule name.

// A fallow `dead-code --format json` report shaped like the real tool's output.
function sampleReport() {
  return {
    summary: {
      unused_exports: 2,
      unused_types: 1,
      unused_files: 1,
      circular_dependencies: 1,
    },
    unused_exports: [
      { name: 'makeBarChart', file: 'backend/src/charts/bar.ts', line: 42 },
      { name: 'helper', file: 'backend/src/util/x.ts', line: 7 },
    ],
    unused_types: [{ name: 'BarOpts', file: 'backend/src/charts/bar.ts', line: 10 }],
    unused_files: [{ path: 'backend/src/orphan.ts' }],
    circular_dependencies: [{ from: 'a.ts', to: 'b.ts' }],
  };
}

test('extractFindings normalises every category to {key, category, name, file, line}', () => {
  const findings = extractFindings(sampleReport());
  // 2 exports + 1 type + 1 file + 1 circular = 5
  assert.equal(findings.length, 5);
  for (const f of findings) {
    assert.ok(typeof f.key === 'string' && f.key.length > 0, 'each finding has a key');
    assert.ok(f.category, 'each finding has a category');
    assert.ok(f.name, 'each finding has a name');
    assert.ok(f.file, 'each finding has a file');
  }
  const exportFinding = findings.find((f) => f.name === 'makeBarChart');
  assert.equal(exportFinding.category, 'unused_exports');
  assert.equal(exportFinding.file, 'backend/src/charts/bar.ts');
  assert.equal(exportFinding.line, 42);
});

test('extractFindings keys are stable and category-scoped (no collisions)', () => {
  const findings = extractFindings(sampleReport());
  const keys = findings.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, 'finding keys must be unique');
  // A symbol named the same in two files must not collide.
  const dup = extractFindings({
    unused_exports: [
      { name: 'x', file: 'a.ts', line: 1 },
      { name: 'x', file: 'b.ts', line: 1 },
    ],
  });
  assert.equal(new Set(dup.map((f) => f.key)).size, 2);
});

test('extractFindings tolerates an empty / missing report', () => {
  assert.deepEqual(extractFindings(null), []);
  assert.deepEqual(extractFindings({}), []);
  assert.deepEqual(extractFindings({ summary: {} }), []);
});

test('diffFindings returns only findings absent from the baseline', () => {
  const findings = extractFindings(sampleReport());
  const baseline = new Set(findings.slice(0, 3).map((f) => f.key));
  const fresh = diffFindings(findings, baseline);
  assert.equal(fresh.length, findings.length - 3);
  for (const f of fresh) assert.ok(!baseline.has(f.key));
});

test('diffFindings on a full baseline yields nothing (no spam on first run)', () => {
  const findings = extractFindings(sampleReport());
  const baseline = new Set(findings.map((f) => f.key));
  assert.deepEqual(diffFindings(findings, baseline), []);
});

test('buildIssueTitle names the rule, symbol, and shortened path', () => {
  const finding = {
    category: 'unused_exports',
    name: 'makeBarChart',
    file: 'backend/src/charts/bar.ts',
    line: 42,
  };
  const title = buildIssueTitle(finding);
  assert.match(title, /^\[chore\]/);
  assert.match(title, /unused-export/);
  assert.match(title, /makeBarChart/);
  assert.match(title, /charts\/bar\.ts/);
});

test('buildIssueBody embeds an exact blob URL with file:line and the rule name', () => {
  const finding = {
    category: 'unused_exports',
    name: 'makeBarChart',
    file: 'backend/src/charts/bar.ts',
    line: 42,
  };
  const body = buildIssueBody(
    finding,
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'https://github.com',
    'Connor-Adams/cashflow',
  );
  assert.match(
    body,
    /https:\/\/github\.com\/Connor-Adams\/cashflow\/blob\/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\/backend\/src\/charts\/bar\.ts#L42/,
    'body must contain a blob URL pinned to the commit SHA, file path, and line',
  );
  assert.match(body, /unused-export/, 'body must name the rule');
  assert.match(body, /- \[ \]/, 'body must include a remediation checkbox');
});

test('buildIssueBody handles a finding without a line number (unused file)', () => {
  const finding = {
    category: 'unused_file',
    name: 'backend/src/orphan.ts',
    file: 'backend/src/orphan.ts',
    line: null,
  };
  const body = buildIssueBody(finding, 'abc123', 'https://github.com', 'Connor-Adams/cashflow');
  assert.match(body, /blob\/abc123\/backend\/src\/orphan\.ts/);
  assert.doesNotMatch(body, /#L/, 'no line anchor when the finding has no line');
});
