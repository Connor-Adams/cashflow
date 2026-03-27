import fs from 'fs';
import path from 'path';
import { Sequelize } from 'sequelize';
import * as env from './config/env';

const dir = path.dirname(env.databasePath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: env.databasePath,
  logging: false,
});
