import fs from 'fs';
import app from './app';
import * as env from './config/env';
import { seedDemoData } from './demo/seedDemoData';
import { logger } from './observability/logger';
import { isS3ReceiptStorageEnabled } from './storage/receiptStorage';
import { startQuoteScheduler } from './integrations/alphaVantage/scheduler';
import { startForwardIncomeScheduler } from './portfolio/forwardIncomeScheduler';
import { startDailySnapshotScheduler } from './portfolio/dailySnapshotScheduler';

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

  startQuoteScheduler();
  startForwardIncomeScheduler();
  startDailySnapshotScheduler();
}

start().catch((err) => {
  logger.error('server_start_failed', { port: env.port }, err);
  process.exit(1);
});
