#!/usr/bin/env node

const { spawnSync } = require('child_process');

const mode = process.argv[2];

if (!['build', 'start', 'migrate'].includes(mode)) {
  console.error('Usage: node scripts/railway-run.cjs <build|start|migrate>');
  process.exit(1);
}

const hint = [
  process.env.RAILWAY_DEPLOY_TARGET,
  process.env.DEPLOY_TARGET,
  process.env.RAILWAY_SERVICE_NAME,
]
  .filter(Boolean)
  .join(' ')
  .toLowerCase();

function targetFromHint(value) {
  if (/\b(frontend|front-end|front|web|ui|client)\b/.test(value)) {
    return 'frontend';
  }
  if (/\b(backend|back-end|back|api|server)\b/.test(value)) {
    return 'backend';
  }
  return '';
}

const target = targetFromHint(hint);

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  process.exit(result.status ?? 1);
}

function assertFrontendApiBase() {
  if (process.env.VITE_API_BASE) return;

  console.error(
    'VITE_API_BASE is required for the Railway frontend service. ' +
      'Set it to the backend public URL, for example: https://backend-production-xxxx.up.railway.app'
  );
  process.exit(1);
}

if (mode === 'migrate') {
  run('yarn', ['workspace', 'cashflow-backend', 'run', 'db:migrate'], {
    NODE_ENV: 'production',
  });
}

if (mode === 'build') {
  if (target === 'frontend') {
    assertFrontendApiBase();
    run('yarn', ['workspace', 'frontend', 'run', 'build']);
  }
  if (target === 'backend') {
    run('yarn', ['workspace', 'cashflow-backend', 'run', 'build']);
  }
  console.log(
    'No Railway deploy target detected; building backend and frontend. ' +
      'Set RAILWAY_DEPLOY_TARGET=backend or frontend per Railway service to build only one.'
  );
  const backend = spawnSync(
    'yarn',
    ['workspace', 'cashflow-backend', 'run', 'build'],
    { stdio: 'inherit', env: process.env }
  );
  if (backend.status !== 0) process.exit(backend.status ?? 1);
  assertFrontendApiBase();
  run('yarn', ['workspace', 'frontend', 'run', 'build']);
}

if (mode === 'start') {
  if (target === 'frontend') {
    run('yarn', [
      'workspace',
      'frontend',
      'run',
      'preview',
      '--host',
      '0.0.0.0',
      '--port',
      process.env.PORT || '4173',
    ]);
  }
  if (target === 'backend') {
    run('yarn', ['workspace', 'cashflow-backend', 'run', 'start'], {
      NODE_ENV: 'production',
    });
  }
  console.error(
    'Unable to detect Railway deploy target. Set RAILWAY_DEPLOY_TARGET=backend ' +
      'on the backend service and RAILWAY_DEPLOY_TARGET=frontend on the frontend service.'
  );
  process.exit(1);
}
