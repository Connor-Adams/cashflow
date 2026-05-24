import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import healthRouter from './routes/health';
import versionRouter from './routes/version';
import accountsRouter from './routes/accounts';
import transactionsRouter from './routes/transactions';
import rulesRouter from './routes/rules';
import importRouter from './routes/import';
import summaryRouter from './routes/summary';
import recurringRouter from './routes/recurring';
import aiRouter from './routes/ai';
import chatRouter from './routes/chat';
import { getChatConfig } from './config/chat';
import receiptsRouter from './routes/receipts';
import authRouter from './routes/auth';
import contactsRouter from './routes/contacts';
import settlementsRouter from './routes/settlements';
import budgetsRouter from './routes/budgets';
import clientLogsRouter from './routes/clientLogs';
import amazonRouter from './routes/amazon';
import externalOrdersRouter from './routes/externalOrders';
import emailIntegrationsRouter from './routes/emailIntegrations';
import portfolioRouter from './routes/portfolio';
import taxRouter from './routes/tax';
import captureRouter, { captureCors } from './routes/capture';
import { attachAuth, requireAuth } from './auth/middleware';
import { logger } from './observability/logger';
import { requestLogger } from './observability/requestLogger';

const app = express();

app.set('trust proxy', env.trustProxy);

app.get('/', (_req, res) => {
  res.json({
    service: 'cashflow-backend',
    health: '/api/health',
  });
});

// Apply the capture CORS allow-list BEFORE the global cors() middleware. The
// global middleware uses a static `origin: env.corsOrigin` (the frontend host)
// which rejects preflights from amazon.{com,ca,co.uk} / reportaproblem.apple.com
// before they ever reach the /api/capture/orders router. By mounting captureCors
// first on that exact path, the bookmarklet preflight gets the right
// Access-Control-Allow-Origin header.
app.use('/api/capture/orders', captureCors);

app.use(
  cors({
    origin: env.corsOrigin,
    credentials: true,
  })
);
app.use(requestLogger);
app.use(express.json({ limit: '2mb' }));
app.use(attachAuth);

app.use('/api/health', healthRouter);
app.use('/api/version', versionRouter);
app.use('/api/auth', authRouter);
app.use('/api/client-logs', clientLogsRouter);
app.use('/api/capture', captureRouter);
app.use('/api', requireAuth);
app.use('/api/accounts', accountsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/settlements', settlementsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/import', importRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/recurring', recurringRouter);
app.use('/api/ai', aiRouter);
if (getChatConfig().enabled) {
  app.use('/api/chat', chatRouter);
}
app.use('/api/amazon', amazonRouter);
app.use('/api/external-orders', externalOrdersRouter);
app.use('/api/email', emailIntegrationsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/tax', taxRouter);
app.use('/api', receiptsRouter);

type ErrorWithMetadata = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const isObjectError = (err: unknown): err is ErrorWithMetadata =>
  Boolean(err) && typeof err === 'object';

const getErrorCode = (err: unknown): string =>
  isObjectError(err) && 'code' in err ? String(err.code) : '';

const getErrorStatus = (err: unknown, code: string): number => {
  if (code === 'LIMIT_FILE_SIZE') {
    return 400;
  }

  const rawStatus =
    isObjectError(err) && 'status' in err
      ? err.status
      : isObjectError(err) && 'statusCode' in err
        ? err.statusCode
        : undefined;
  const status = Number(rawStatus) || 500;

  return status >= 400 && status < 600 ? status : 500;
};

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error && err.message && !err.message.includes('ENOENT')) {
    return err.message;
  }

  return 'Internal Server Error';
};

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = getErrorCode(err);
  const responseStatus = getErrorStatus(err, code);
  const requestContext = {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.originalUrl || _req.url,
    statusCode: responseStatus,
    userId: _req.auth?.user.id,
    householdId: _req.auth?.household.id,
  };
  if (responseStatus >= 500) {
    logger.error('request_failed', requestContext, err);
  } else {
    logger.warn('request_failed', {
      ...requestContext,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : undefined,
    });
  }
  if (code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File too large (max 15MB)' });
    return;
  }

  res.status(responseStatus).json({
    error: getErrorMessage(err),
  });
});

export default app;
