import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import healthRouter from './routes/health';
import accountsRouter from './routes/accounts';
import transactionsRouter from './routes/transactions';
import rulesRouter from './routes/rules';
import importRouter from './routes/import';
import summaryRouter from './routes/summary';
import aiRouter from './routes/ai';
import receiptsRouter from './routes/receipts';
import authRouter from './routes/auth';
import contactsRouter from './routes/contacts';
import clientLogsRouter from './routes/clientLogs';
import amazonRouter from './routes/amazon';
import portfolioRouter from './routes/portfolio';
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
app.use('/api/auth', authRouter);
app.use('/api/client-logs', clientLogsRouter);
app.use('/api', requireAuth);
app.use('/api/accounts', accountsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/import', importRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/ai', aiRouter);
app.use('/api/amazon', amazonRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api', receiptsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
  const statusRaw =
    err && typeof err === 'object' && 'status' in err
      ? (err as { status?: number }).status
      : err && typeof err === 'object' && 'statusCode' in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
  const status = code === 'LIMIT_FILE_SIZE' ? 400 : Number(statusRaw) || 500;
  const responseStatus = status >= 400 && status < 600 ? status : 500;
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
  const message =
    err instanceof Error && err.message && !String(err.message).includes('ENOENT')
      ? err.message
      : 'Internal Server Error';
  res.status(responseStatus).json({
    error: message,
  });
});

export default app;
