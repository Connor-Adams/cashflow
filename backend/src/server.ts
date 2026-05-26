import fs from 'fs';
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
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

const lookupAsync = promisify(lookup);

async function probeRailwayDns(): Promise<void> {
  const hosts = ['otel-collector.railway.internal', 'loki.railway.internal'];
  for (const host of hosts) {
    try {
      // family: 0 accepts either IPv4 or IPv6 — Railway internal is IPv6-only.
      const result = await lookupAsync(host, { family: 0, all: true });
      logger.info({ host, addresses: result }, 'dns_probe_ok');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      logger.warn({ host, code: e.code, message: e.message }, 'dns_probe_failed');
    }
  }
}

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function start() {
  await seedDemoData();
  await probeRailwayDns();

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
