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
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
  });
});

module.exports = app;
