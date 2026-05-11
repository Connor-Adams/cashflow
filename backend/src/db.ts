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
  });
}

export const sequelize = createSequelize();
