const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SERVICES } = require('../scripts/service-content-hash.cjs');

const workflow = readFileSync('.github/workflows/build-images.yml', 'utf8');

test('build-images splits into a detect job and a content-gated build job', () => {
  assert.match(workflow, /^\s{2}detect:/m, 'detect job present');
  assert.match(workflow, /^\s{2}build:/m, 'build job present');

  // detect publishes the matrix + a flag for whether anything needs building.
  assert.match(workflow, /matrix:\s*\$\{\{\s*steps\.detect\.outputs\.matrix\s*\}\}/);
  assert.match(workflow, /any:\s*\$\{\{\s*steps\.detect\.outputs\.any\s*\}\}/);

  // build only runs when detect found work, over the detect-computed matrix.
  assert.match(workflow, /needs\.detect\.outputs\.any == 'true'/);
  assert.match(workflow, /matrix:\s*\$\{\{\s*fromJSON\(needs\.detect\.outputs\.matrix\)\s*\}\}/);
});

test('detect skips by content hash via the shared script', () => {
  assert.match(workflow, /node scripts\/service-content-hash\.cjs/);
  assert.match(
    workflow,
    /docker buildx imagetools inspect "\$\{image\}:tree-\$\{hash\}"/,
    'detect must check for the :tree-<hash> tag',
  );
});

test('build tags the content-addressed identity', () => {
  assert.match(
    workflow,
    /:tree-\$\{\{ matrix\.hash \}\}/,
    'built image must carry its :tree-<hash> tag',
  );
});

test('every service is covered by the detect matrix', () => {
  for (const svc of SERVICES) {
    assert.match(
      workflow,
      new RegExp(`"${svc}\\|`),
      `detect SERVICES list must include ${svc}`,
    );
  }
});
