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
import receiptsRouter from './routes/receipts';
import itemsRouter from './routes/items';
import authRouter from './routes/auth';
import contactsRouter from './routes/contacts';
import categoriesRouter from './routes/categories';
import settlementsRouter from './routes/settlements';
import budgetsRouter from './routes/budgets';
import insightsRouter from './routes/insights';
import plannedEventsRouter from './routes/plannedEvents';
import goalsRouter from './routes/goals';
import forecastRouter from './routes/forecast';
import clientLogsRouter from './routes/clientLogs';
import amazonRouter from './routes/amazon';
import externalOrdersRouter from './routes/externalOrders';
import emailIntegrationsRouter from './routes/emailIntegrations';
import netWorthRouter from './routes/netWorth';
import portfolioRouter from './routes/portfolio';
import taxRouter from './routes/tax';
import householdRouter from './routes/household';
import taxPersonalScenariosRouter from './routes/tax-personal-scenarios';
import taxCorpScenariosRouter from './routes/tax-corp-scenarios';
import taxHouseholdPlansRouter from './routes/tax-household-plans';
import captureRouter, { captureCors } from './routes/capture';
import configRouter from './routes/config';
import { attachAuth, requireAuth } from './auth/middleware';
import { logger } from './observability/logger';
import { requestLogger } from './observability/requestLogger';
import { withContext } from './observability/requestContext';

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
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.auth) {
    withContext(
      {
        userId: String(req.auth.user.id),
        householdId: String(req.auth.household.id),
        role: req.auth.role,
      },
      () => next(),
    );
  } else {
    next();
  }
});

app.use('/api/health', healthRouter);
app.use('/api/version', versionRouter);
app.use('/api/config', configRouter);
app.use('/api/auth', authRouter);
app.use('/api/client-logs', clientLogsRouter);
app.use('/api/capture', captureRouter);
app.use('/api', requireAuth);
app.use('/api/accounts', accountsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/settlements', settlementsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/planned-events', plannedEventsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/import', importRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/recurring', recurringRouter);
app.use('/api/ai', aiRouter);
app.use('/api/chat', chatRouter);
app.use('/api/amazon', amazonRouter);
app.use('/api/external-orders', externalOrdersRouter);
app.use('/api/email', emailIntegrationsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/household', householdRouter);
app.use('/api/net-worth', netWorthRouter);
app.use('/api/tax/personal-scenarios', taxPersonalScenariosRouter);
app.use('/api/tax/corp-scenarios', taxCorpScenariosRouter);
app.use('/api/tax/household-plans', taxHouseholdPlansRouter);
app.use('/api/tax', taxRouter);
app.use('/api', receiptsRouter);
app.use('/api', itemsRouter);

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
    logger.error({ ...requestContext, err }, 'request_failed');
  } else {
    logger.warn({
      ...requestContext,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : undefined,
    }, 'request_failed');
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
