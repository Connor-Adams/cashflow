import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const root = path.join(__dirname, '..', '..');

export const csvUploadDir =
  process.env.CSV_UPLOAD_DIR || path.join(root, 'uploads', 'csv');

export const databasePath =
  process.env.DATABASE_PATH || path.join(root, 'data', 'cashflow.sqlite');

export const port = Number(process.env.PORT || 3001);

export const defaultCurrency = process.env.DEFAULT_CURRENCY || 'CAD';

export const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

export const nodeEnv = process.env.NODE_ENV || 'development';
