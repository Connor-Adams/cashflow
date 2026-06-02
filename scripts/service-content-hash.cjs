#!/usr/bin/env node

// Content-addressed identity for each deployable image. A service's hash is
// derived from the git object ids of its input paths, so it changes iff that
// service's source changes. build-images.yml builds a service only when its
// :tree-<hash> tag is absent; promote-to-production.yml resolves each service by
// the same hash. Both call THIS module, so they can never disagree about what a
// given commit should build or deploy.
//
// See docs/superpowers/specs/2026-06-02-skip-unchanged-image-builds-design.md.

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// Bump to force a rebuild of ALL services when something outside the source tree
// changes the image (build-logic edits, a floating base image like node:22-slim
// or nginx:alpine). Kept as a constant — NOT an env var — so build and promote
// can never compute different hashes for the same commit.
const EPOCH = '1';

// Each service's build inputs, as git pathspecs. Derived from the Dockerfiles:
// backend/frontend copy the root manifests + their own workspace + shared/;
// every infra service builds from its self-contained infra/<svc> context.
const INPUTS = {
  backend: ['package.json', 'yarn.lock', 'backend', 'shared'],
  frontend: ['package.json', 'yarn.lock', 'frontend', 'shared'],
  'otel-collector': ['infra/otel-collector'],
  loki: ['infra/loki'],
  prometheus: ['infra/prometheus'],
  grafana: ['infra/grafana'],
  tempo: ['infra/tempo'],
};

const SERVICES = Object.keys(INPUTS);

function serviceContentHash(service, ref = 'HEAD', { cwd } = {}) {
  const paths = INPUTS[service];
  if (!paths) {
    throw new Error(`unknown service: ${service}`);
  }
  // `git rev-parse <ref>:<path>` yields the tree (dir) or blob (file) object id
  // for that path at that commit. Throws if the path is missing — fail loud.
  const lines = [`epoch:${EPOCH}`];
  for (const p of paths) {
    const oid = execFileSync('git', ['rev-parse', `${ref}:${p}`], {
      cwd,
      encoding: 'utf8',
    }).trim();
    lines.push(`${p}:${oid}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

module.exports = { serviceContentHash, SERVICES, INPUTS, EPOCH };

if (require.main === module) {
  const [service, ref] = process.argv.slice(2);
  if (!service) {
    console.error('usage: node scripts/service-content-hash.cjs <service> [ref]');
    process.exit(1);
  }
  try {
    process.stdout.write(`${serviceContentHash(service, ref || 'HEAD')}\n`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
