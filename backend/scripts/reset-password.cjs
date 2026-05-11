#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pg = require('pg');
const sqlite3 = require('sqlite3');

const scryptAsync = promisify(crypto.scrypt);
const KEY_LEN = 64;
const PASSWORD_PARAMS = 'scrypt:N=16384,r=8,p=1,keyLen=64';

function usage() {
  console.error(
    [
      'Usage:',
      '  node backend/scripts/reset-password.cjs --email user@example.com --password new-password',
      '',
      'Options:',
      '  --database-url postgres://...       Override DATABASE_URL',
      '  --database /path/to/cashflow.sqlite  Override DATABASE_PATH',
    ].join('\n')
  );
}

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function databasePath(raw) {
  if (raw) return path.resolve(raw);
  if (process.env.DATABASE_URL) return null;
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  return path.join(__dirname, '..', 'data', 'cashflow.sqlite');
}

function openDb(file) {
  return new sqlite3.Database(file, sqlite3.OPEN_READWRITE);
}

function get(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await scryptAsync(password, salt, KEY_LEN);
  return {
    hash: key.toString('base64url'),
    salt,
    params: PASSWORD_PARAMS,
  };
}

async function resetPostgres(databaseUrl, email, passwordData) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const user = await client.query(
      'select id, email from users where lower(email) = lower($1)',
      [email]
    );
    if (user.rowCount === 0) {
      throw new Error(`No user found for email: ${email}`);
    }

    await client.query(
      [
        'update users',
        'set password_hash = $1, password_salt = $2, password_params = $3, updated_at = CURRENT_TIMESTAMP',
        'where id = $4',
      ].join(' '),
      [passwordData.hash, passwordData.salt, passwordData.params, user.rows[0].id]
    );

    console.log(`Password reset for ${user.rows[0].email} in Postgres`);
  } finally {
    await client.end();
  }
}

async function resetSqlite(dbPath, email, passwordData) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = openDb(dbPath);
  try {
    const user = await get(db, 'select id, email from users where lower(email) = ?', [email]);
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    await run(
      db,
      [
        'update users',
        'set password_hash = ?, password_salt = ?, password_params = ?, updated_at = CURRENT_TIMESTAMP',
        'where id = ?',
      ].join(' '),
      [passwordData.hash, passwordData.salt, passwordData.params, user.id]
    );

    console.log(`Password reset for ${user.email} in ${dbPath}`);
  } finally {
    db.close();
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const email = String(args.email || '').trim().toLowerCase();
  const password = String(args.password || '');
  const dbUrl = args['database-url'] || process.env.DATABASE_URL || null;
  const dbPath = databasePath(args.database);

  if (!email || !password) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const passwordData = await hashPassword(password);

  if (dbUrl) {
    await resetPostgres(dbUrl, email, passwordData);
  } else {
    await resetSqlite(dbPath, email, passwordData);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
