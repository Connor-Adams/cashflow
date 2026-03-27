import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import healthRouter from './routes/health';
import accountsRouter from './routes/accounts';
import transactionsRouter from './routes/transactions';
import rulesRouter from './routes/rules';
import importRouter from './routes/import';
import summaryRouter from './routes/summary';

const app = express();

app.use(
  cors({
    origin: env.corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

app.use('/api/health', healthRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/import', importRouter);
app.use('/api/summary', summaryRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
  if (code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File too large (max 15MB)' });
    return;
  }
  const statusRaw =
    err && typeof err === 'object' && 'status' in err
      ? (err as { status?: number }).status
      : err && typeof err === 'object' && 'statusCode' in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
  const status = Number(statusRaw) || 500;
  const message =
    err instanceof Error && err.message && !String(err.message).includes('ENOENT')
      ? err.message
      : 'Internal Server Error';
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: message,
  });
});

export default app;
