import fs from 'fs';
import app from './app';
import * as env from './config/env';
import { seedDemoData } from './demo/seedDemoData';
import { backfillUsdCadHistory } from './fx/backfillUsdCadHistory';
import { logger } from './observability/logger';
import { isS3ReceiptStorageEnabled } from './storage/receiptStorage';
import { startQuoteScheduler } from './integrations/yahoo/scheduler';
import { startForwardIncomeScheduler } from './portfolio/forwardIncomeScheduler';
import { startDailySnapshotScheduler } from './portfolio/dailySnapshotScheduler';

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function start() {
  await seedDemoData();

  app.listen(env.port, () => {
    logger.info({
      port: env.port,
      nodeEnv: env.nodeEnv,
      uploadDir,
      receiptStorage: isS3ReceiptStorageEnabled() ? 's3' : 'local',
    }, 'server_started');
  });

  // Backfill USD→CAD daily noon rates for the last 5 years. Idempotent: skips
  // existing rows. Runs in the background; failures are non-fatal (logged).
  const today = new Date().toISOString().slice(0, 10);
  const fiveYearsAgo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().slice(0, 10);
  })();
  backfillUsdCadHistory({ startDate: fiveYearsAgo, endDate: today }).catch((err) => {
    logger.warn({ err }, 'boot_usd_cad_backfill_failed');
  });

  startQuoteScheduler();
  startForwardIncomeScheduler();
  startDailySnapshotScheduler();
}

start().catch((err) => {
  logger.error({ err, port: env.port }, 'server_start_failed');
  process.exit(1);
});
