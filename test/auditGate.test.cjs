const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateAudit,
  ZEROABLE_CATEGORIES,
  DUP_CEILING,
} = require('../scripts/audit-gate.cjs');

// A clean baseline: every zeroable category at 0, duplication at the post-#468
// figure (3.98%), plus complexity fields that must be ignored.
function cleanDeadcode(overrides = {}) {
  const summary = {
    unused_files: 0,
    unused_exports: 0,
    unused_types: 0,
    unused_class_members: 0,
    duplicate_exports: 0,
    unused_dependencies: 0,
    unlisted_dependencies: 0,
    circular_dependencies: 0,
    // Non-zeroable categories fallow may still report — must NOT gate on these.
    unused_enum_members: 3,
    unresolved_imports: 1,
    private_type_leaks: 9,
    ...overrides,
  };
  return { summary };
}

function jscpdAt(percentage) {
  return { statistics: { total: { percentage, clones: 0, duplicatedLines: 0 } } };
}

test('clean baseline passes', () => {
  const result = evaluateAudit({
    deadcode: cleanDeadcode(),
    jscpd: jscpdAt(3.98),
  });
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.deepEqual(result.failures, []);
});

test('each zeroable category > 0 fails the gate', () => {
  for (const [key, label] of ZEROABLE_CATEGORIES) {
    const result = evaluateAudit({
      deadcode: cleanDeadcode({ [key]: 1 }),
      jscpd: jscpdAt(3.98),
    });
    assert.equal(result.ok, false, `${key} > 0 should fail`);
    assert.ok(
      result.failures.some((f) => f.includes(key)),
      `failure message should name ${key} (${label})`,
    );
  }
});

test('non-zeroable dead-code categories never block', () => {
  // High counts for enum members / unresolved imports / private type leaks must
  // not affect the verdict — they are outside the zeroable-8 baseline.
  const result = evaluateAudit({
    deadcode: cleanDeadcode({
      unused_enum_members: 50,
      unresolved_imports: 50,
      private_type_leaks: 50,
    }),
    jscpd: jscpdAt(3.98),
  });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('complexity / health fields never block', () => {
  // A dead-code report carrying complexity-shaped noise still passes.
  const dc = cleanDeadcode();
  dc.summary.severity_critical_count = 488;
  dc.summary.severity_high_count = 312;
  const result = evaluateAudit({ deadcode: dc, jscpd: jscpdAt(3.98) });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('duplication exactly at the ceiling passes (strict >)', () => {
  const result = evaluateAudit({
    deadcode: cleanDeadcode(),
    jscpd: jscpdAt(DUP_CEILING),
  });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('duplication above the ceiling fails', () => {
  const result = evaluateAudit({
    deadcode: cleanDeadcode(),
    jscpd: jscpdAt(4.01),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /Duplication/.test(f)));
});

test('ceiling is 4.0%', () => {
  assert.equal(DUP_CEILING, 4.0);
});

test('exactly the eight zeroable categories are enforced', () => {
  const keys = ZEROABLE_CATEGORIES.map(([k]) => k).sort();
  assert.deepEqual(keys, [
    'circular_dependencies',
    'duplicate_exports',
    'unlisted_dependencies',
    'unused_class_members',
    'unused_dependencies',
    'unused_exports',
    'unused_files',
    'unused_types',
  ]);
});

test('missing dead-code report fails closed', () => {
  const result = evaluateAudit({ deadcode: null, jscpd: jscpdAt(3.98) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /dead-code report missing/.test(f)));
});

test('missing jscpd report fails closed', () => {
  const result = evaluateAudit({ deadcode: cleanDeadcode(), jscpd: null });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /jscpd report missing/.test(f)));
});

test('both reports missing yields two failures', () => {
  const result = evaluateAudit({ deadcode: null, jscpd: null });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 2);
});
