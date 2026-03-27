const path = require('path');

function assertUnderRoot(rootDir, resolvedPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(resolvedPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes upload directory');
  }
}

module.exports = { assertUnderRoot };
