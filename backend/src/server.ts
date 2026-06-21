// MUST be first: registers NodeSDK + auto-instrumentations before other modules load.
import './observability/otel';
import './observability/metrics';
import fs from 'fs';
import app from './app';
import * as env from './config/env';
import { seedDemoData } from './demo/seedDemoData';
import { logger } from './observability/logger';
import { isS3ReceiptStorageEnabled } from './storage/receiptStorage';
import { registerDbPoolMetrics } from './observability/metrics';
import { isEncryptionKeyConfigured } from './util/symmetricEncryption';
import { sequelize } from './db';
// Register job definitions (side-effect imports).
import './jobs/definitions/yahooQuote';
import './jobs/definitions/dailySnapshot';
import './jobs/definitions/forwardIncome';
import './jobs/definitions/enrichmentBackfill';
import './jobs/definitions/usdCadBackfill';
import './jobs/definitions/weeklyDigest';
import './jobs/definitions/budgetBreachCheck';
import './jobs/definitions/dividendReconciliation';
import './jobs/definitions/detectSubscriptionPriceChanges';
import './jobs/definitions/jobRunCleanup';
import './jobs/definitions/auditBufferTrim';
import './jobs/definitions/pdfImportProcess';
import './jobs/definitions/simplefinSync';
import { startAllJobs } from './jobs';

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

registerDbPoolMetrics(sequelize);

async function start() {
  // Loud, actionable boot warning when the encryption key is missing/invalid.
  // SimpleFIN and email integrations both require it and will fail at connect
  // time otherwise. Warn once at startup so operators catch it before a user
  // hits a doomed bank-connect flow. (#814)
  if (!isEncryptionKeyConfigured()) {
    logger.warn(
      'EMAIL_INTEGRATION_ENCRYPTION_KEY is not set (or not a 64-char hex string). ' +
        'SimpleFIN and email integrations will fail until it is configured. ' +
        'Generate one with: openssl rand -hex 32',
    );
  }

  await seedDemoData();

  app.listen(env.port, () => {
    logger.info({
      port: env.port,
      nodeEnv: env.nodeEnv,
      uploadDir,
      receiptStorage: isS3ReceiptStorageEnabled() ? 's3' : 'local',
    }, 'server_started');
  });

  await startAllJobs();
}

start().catch((err) => {
  logger.error({ err, port: env.port }, 'server_start_failed');
  process.exit(1);
});
