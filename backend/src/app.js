const express = require('express');
const cors = require('cors');
const env = require('./config/env');

const healthRouter = require('./routes/health');
const accountsRouter = require('./routes/accounts');
const transactionsRouter = require('./routes/transactions');
const rulesRouter = require('./routes/rules');
const importRouter = require('./routes/import');
const summaryRouter = require('./routes/summary');

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

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File too large (max 15MB)' });
    return;
  }
  const status = Number(err.status || err.statusCode) || 500;
  const message =
    err.message && !String(err.message).includes('ENOENT')
      ? err.message
      : 'Internal Server Error';
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: message,
  });
});

module.exports = app;
