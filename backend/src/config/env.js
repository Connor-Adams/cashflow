const path = require('path');
require('dotenv').config();

const root = path.join(__dirname, '..', '..');

const csvUploadDir =
  process.env.CSV_UPLOAD_DIR || path.join(root, 'uploads', 'csv');

const databasePath =
  process.env.DATABASE_PATH || path.join(root, 'data', 'cashflow.sqlite');

const port = Number(process.env.PORT || 3001);

const defaultCurrency = process.env.DEFAULT_CURRENCY || 'CAD';

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

module.exports = {
  csvUploadDir,
  databasePath,
  port,
  defaultCurrency,
  corsOrigin,
  nodeEnv: process.env.NODE_ENV || 'development',
};
