import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import * as env from './config/env';

import healthRouter from './routes/health';
import versionRouter from './routes/version';
import accountsRouter from './routes/accounts';
import transactionsRouter from './routes/transactions';
import transfersRouter from './routes/transfers';
import statementsRouter from './routes/statements';
import rulesRouter from './routes/rules';
import importRouter from './routes/import';
import summaryRouter from './routes/summary';
import sankeyRouter from './routes/sankey';
import merchantsRouter from './routes/merchants';
import recurringRouter from './routes/recurring';
import subscriptionsRouter from './routes/subscriptions';
import moneyLeaksRouter from './routes/moneyLeaks';
import reportsRouter from './routes/reports';
import aiRouter from './routes/ai';
import aiQueryRouter from './routes/aiQuery';
import aiReviewRouter from './routes/aiReview';
import cfoBriefingsRouter from './routes/cfoBriefings';
import chatRouter from './routes/chat';
import receiptsRouter from './routes/receipts';
import itemsRouter from './routes/items';
import purchasesRouter from './routes/purchases';
import reimbursementsRouter from './routes/reimbursements';
import largePurchaseReviewRouter from './routes/largePurchaseReview';
import feedbackRouter from './routes/feedback';
import financialScenariosRouter from './routes/financialScenarios';
import dataQualityRouter from './routes/dataQuality';
import authRouter from './routes/auth';
import contactsRouter from './routes/contacts';
import categoriesRouter from './routes/categories';
import labelsRouter from './routes/labels';
import settlementsRouter from './routes/settlements';
import partnerRouter from './routes/partner';
import budgetsRouter from './routes/budgets';
import insightsRouter from './routes/insights';
import plannedEventsRouter from './routes/plannedEvents';
import monthlyCloseRouter from './routes/monthlyClose';
import calendarRouter from './routes/calendar';
import goalsRouter from './routes/goals';
import notificationsRouter from './routes/notifications';
import notificationPreferencesRouter from './routes/notificationPreferences';
import notificationsAdminRouter from './routes/admin/notificationsAdmin';
import forecastRouter from './routes/forecast';
import debtRouter from './routes/debt';
import creditCardsRouter from './routes/creditCards';
import opportunityCostRouter from './routes/opportunityCost';
import cashflowSettingsRouter from './routes/cashflowSettings';
import preferencesRouter from './routes/preferences';
import onboardingRouter from './routes/onboarding';
import clientLogsRouter from './routes/clientLogs';
import amazonRouter from './routes/amazon';
import externalOrdersRouter from './routes/externalOrders';
import emailIntegrationsRouter from './routes/emailIntegrations';
import netWorthRouter from './routes/netWorth';
import fxRouter from './routes/fx';
import portfolioRouter from './routes/portfolio';
import taxRouter from './routes/tax';
import businessTaxRouter from './routes/businessTax';
import returnWarrantyRouter from './routes/returnWarranty';
import taxReserveRouter from './routes/taxReserve';
import householdRouter from './routes/household';
import invitesRouter from './routes/invites';
import taxScenariosRouter from './routes/tax-scenarios';
import taxPersonalScenariosRouter from './routes/tax-personal-scenarios';
import taxCorpScenariosRouter from './routes/tax-corp-scenarios';
import taxHouseholdPlansRouter from './routes/tax-household-plans';
import captureRouter, { captureCors } from './routes/capture';
import auditTokensRouter from './routes/auditTokens';
import auditRouter from './routes/audit';
import configRouter from './routes/config';
import auditLogRouter from './routes/auditLog';
import vaultRouter from './routes/vault';
import financeEventsRouter from './routes/financeEvents';
import syncRouter from './routes/sync';
import jobsRouter from './jobs/api';
import searchRouter from './routes/search';
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
app.use('/api/audit/tokens', auditTokensRouter);  // session auth — must mount BEFORE /api/audit
app.use('/api/audit', auditRouter);               // bearer auth
app.use('/api', requireAuth);
app.use('/api/jobs', jobsRouter);
app.use('/api/search', searchRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/transfers', transfersRouter);
app.use('/api/statements', statementsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/labels', labelsRouter);
app.use('/api/settlements', settlementsRouter);
app.use('/api/partner', partnerRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/planned-events', plannedEventsRouter);
app.use('/api/monthly-close', monthlyCloseRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/notification-preferences', notificationPreferencesRouter);
app.use('/api/admin/notifications', notificationsAdminRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/debt', debtRouter);
app.use('/api/credit-cards', creditCardsRouter);
app.use('/api/opportunity-cost', opportunityCostRouter);
app.use('/api/financial-scenarios', financialScenariosRouter);
app.use('/api/settings/cashflow', cashflowSettingsRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/import', importRouter);
// sankeyRouter mounts before summaryRouter so /api/summary/sankey/* wins
// against any future /:id-style routes added to summaryRouter. The
// remainder of /api/summary/* keeps flowing to summaryRouter below.
app.use('/api/summary/sankey', sankeyRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/merchants', merchantsRouter);
app.use('/api/recurring', recurringRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/data-quality', dataQualityRouter);
app.use('/api/money-leaks', moneyLeaksRouter);
app.use('/api/audit-log', auditLogRouter);
app.use('/api/vault', vaultRouter);
app.use('/api/finance-events', financeEventsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/reports', reportsRouter);
// AI review router (issue #210) mounted BEFORE aiRouter so its /review and
// /reviews/* paths win against any future overlap. Both share the /api/ai
// prefix to satisfy the issue's endpoint spec.
app.use('/api/ai', aiReviewRouter);
// Personal CFO briefings (issue #236).
app.use('/api/cfo', cfoBriefingsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/ai', aiQueryRouter);
app.use('/api/chat', chatRouter);
app.use('/api/amazon', amazonRouter);
app.use('/api/external-orders', externalOrdersRouter);
app.use('/api/email', emailIntegrationsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/household', householdRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/net-worth', netWorthRouter);
app.use('/api/fx', fxRouter);
// Unified tax scenarios router (dispatches on `kind` query param).
// Mounted BEFORE the legacy personal/corp routers so the new route wins;
// the old mounts below now return 410 Gone for backward-compat signalling.
app.use('/api/tax/scenarios', taxScenariosRouter);
app.use('/api/tax/personal-scenarios', taxPersonalScenariosRouter);
app.use('/api/tax/corp-scenarios', taxCorpScenariosRouter);
app.use('/api/tax/household-plans', taxHouseholdPlansRouter);
app.use('/api/tax/reserve', taxReserveRouter);
app.use('/api/tax', taxRouter);
// businessTaxRouter mounts /business/*, /exports/tax, /tax-tags, and
// /transactions/:id/tax under /api. Keep it BEFORE other catch-all /api mounts.
app.use('/api', businessTaxRouter);
// returnWarrantyRouter mounts /return-warranty/* and
// /transactions/:id/return-warranty under /api. Keep BEFORE other catch-all
// mounts so its specific paths win.
app.use('/api', returnWarrantyRouter);
app.use('/api', receiptsRouter);
app.use('/api', itemsRouter);
app.use('/api', purchasesRouter);
// reimbursementsRouter mounts /reimbursements/* and
// /transactions/:id/reimbursable under /api (issue #216).
app.use('/api', reimbursementsRouter);
// largePurchaseReviewRouter mounts /large-purchases/* and
// /transactions/:id/large-purchase-review under /api (issue #244).
app.use('/api', largePurchaseReviewRouter);
// feedbackRouter mounts /feedback and /feedback/:id/resolve under /api
// (issue #295). Behind the global requireAuth above.
app.use('/api', feedbackRouter);

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
