/**
 * Manual smoke test: import a few real Wealthsimple bundle CSVs through
 * `importWsBundleFile` directly (no HTTP). Run with:
 *
 *   yarn tsx scripts/wsBundleSmoke.ts /path/to/bundle/dir
 *
 * Deletes its own test DB on exit. Intended for one-off verification only.
 */
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const dbPath = path.join(backendRoot, 'data', 'ws-smoke.sqlite');

async function main() {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error('Usage: yarn tsx scripts/wsBundleSmoke.ts <bundle-dir>');
    process.exit(1);
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  try {
    await fs.unlink(dbPath);
  } catch {
    /* ignore */
  }

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const models = await import('../src/models/index.js');
  const { Household, User, HouseholdMember } = models;
  const { hashPassword } = await import('../src/auth/password.js');
  const pw = await hashPassword('smokesmokesmoke');
  const user = await User.create({
    email: 'smoke@example.com',
    displayName: 'Smoke',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
    globalRole: 'user',
  });
  const household = await Household.create({ name: 'Smoke Household' });
  await HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  const { importWsBundleFile } = await import('../src/import/runImport.js');

  const filenames = [
    'Chequing-2025-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
    'Corporate-investing-2026-01-01-monthly-statement-transactions-HQ8H0GZ07CAD.csv',
    'Wealthsimple-credit-card-2025-12-01-credit-card-statement-transactions-ca-credit-card-oaa9hcx83A.csv',
    'Crypto-2025-09-01-monthly-statement-transactions-HQ6R28910CAD.csv',
  ];

  for (const fname of filenames) {
    const buf = await fs.readFile(path.join(bundleDir, fname));
    const result = await importWsBundleFile({
      buffer: buf,
      fileName: fname,
      householdId: household.id,
      userId: user.id,
    });
    console.log(JSON.stringify(result, null, 2));
  }

  await models.sequelize.close();
  try {
    await fs.unlink(dbPath);
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
