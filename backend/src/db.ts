import fs from 'fs';
import path from 'path';
import { Sequelize } from 'sequelize';
import * as env from './config/env';

function createSequelize(): Sequelize {
  if (env.databaseUrl) {
    return new Sequelize(env.databaseUrl, {
      dialect: 'postgres',
      logging: false,
    });
  }

  const dir = path.dirname(env.databasePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Sequelize({
    dialect: 'sqlite',
    storage: env.databasePath,
    logging: false,
    hooks: {
      afterConnect: async (connection: unknown) => {
        // SQLite's default behavior is to fail immediately with SQLITE_BUSY
        // when a connection can't acquire the write lock. The post-capture
        // backfill runs via setImmediate after responding, so a follow-up
        // request can land while the backfill still holds the lock. Wait up
        // to 5s for the lock instead of throwing 500.
        await new Promise<void>((resolve, reject) => {
          (connection as { run: (sql: string, cb: (err: Error | null) => void) => void }).run(
            'PRAGMA busy_timeout = 5000;',
            (err) => (err ? reject(err) : resolve()),
          );
        });
      },
    },
  });
}

export const sequelize = createSequelize();
