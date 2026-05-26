import fs from 'fs';
import app from './app';
import * as env from './config/env';
import { seedDemoData } from './demo/seedDemoData';
import { logger } from './observability/logger';
import { isS3ReceiptStorageEnabled } from './storage/receiptStorage';
// Register job definitions (side-effect imports).
import './jobs/definitions/yahooQuote';
import './jobs/definitions/dailySnapshot';
import './jobs/definitions/forwardIncome';
import './jobs/definitions/enrichmentBackfill';
import './jobs/definitions/usdCadBackfill';
import { startAllJobs } from './jobs';

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function start() {
  await seedDemoData();

  app.listen(env.port, () => {
    logger.info('server_started', {
      port: env.port,
      nodeEnv: env.nodeEnv,
      uploadDir,
      receiptStorage: isS3ReceiptStorageEnabled() ? 's3' : 'local',
    });
  });

  await startAllJobs();
}

start().catch((err) => {
  logger.error('server_start_failed', { port: env.port }, err);
  process.exit(1);
});
