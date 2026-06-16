/**
 * Declarative router-mount registry for the Express app (see app.ts).
 *
 * WHY THIS EXISTS
 * ───────────────
 * ~90 routers mount under /api. Their order is **load-bearing**: specific paths
 * must out-rank bare-`/api` catch-alls, retired endpoints must keep returning
 * 410 Gone, and a single global `requireAuth` boundary separates public/token-
 * authed routers (mounted before it) from session-gated routers (mounted after).
 * Encoding all of that as a long imperative sequence of `app.use(...)` calls made
 * the ordering implicit and the auth boundary a buried line that was trivial to
 * cross by accident.
 *
 * This module makes the structure DATA:
 *   - `preAuthRoutes`  — ordered entries mounted BEFORE the auth boundary.
 *   - the auth boundary itself — `requireAuth`, applied by `mountRoutes` between
 *     the two arrays. It is structural, not a list item, so nothing can be
 *     "accidentally" placed on the wrong side of it.
 *   - `gatedRoutes`    — ordered entries mounted AFTER the auth boundary.
 *
 * Each `RouteEntry` carries its mount path(s), its handler chain (one or more
 * middlewares/routers, supporting multi-path mounts and bare-`/api` catch-alls),
 * and a `why` note explaining the order — the rationale that used to live in an
 * inline comment now travels with the data.
 *
 * BEHAVIOR-PRESERVING: `mountRoutes(app)` reproduces the exact prior mount order,
 * paths, middleware chains, and 410 stubs. The array index *is* the mount order;
 * the entry at index i is `app.use(paths, ...handlers)` applied i-th.
 */
import { Router, type Express, type RequestHandler, type Request, type Response } from 'express';

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
import reviewItemsRouter from './routes/reviewItems';
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
import usersNotificationsRouter from './routes/usersNotifications';
import notificationsAdminRouter from './routes/admin/notificationsAdmin';
import forecastRouter from './routes/forecast';
import debtRouter from './routes/debt';
import creditCardsRouter from './routes/creditCards';
import opportunityCostRouter from './routes/opportunityCost';
import cashflowSettingsRouter from './routes/cashflowSettings';
import activationStateRouter from './routes/activationState';
import savedFiltersRouter from './routes/savedFilters';
import changelogRouter from './routes/changelog';
import preferencesRouter from './routes/preferences';
import onboardingRouter from './routes/onboarding';
import clientLogsRouter from './routes/clientLogs';
import amazonRouter from './routes/amazon';
import externalOrdersRouter from './routes/externalOrders';
import emailIntegrationsRouter from './routes/emailIntegrations';
import netWorthRouter from './routes/netWorth';
import fxRouter from './routes/fx';
import portfolioRouter from './routes/portfolio';
import dividendsRouter from './routes/dividends';
import taxRouter from './routes/tax';
import businessTaxRouter from './routes/businessTax';
import returnWarrantyRouter from './routes/returnWarranty';
import taxReserveRouter from './routes/taxReserve';
import householdRouter from './routes/household';
import invitesRouter from './routes/invites';
import taxScenariosRouter from './routes/tax-scenarios';
import taxHouseholdPlansRouter from './routes/tax-household-plans';
import captureRouter from './routes/capture';
import reportingTokensRouter from './routes/reportingTokens';
import reportingRouter from './routes/reporting';
import { reportingAuth } from './auth/reportingAuth';
import auditTokensRouter from './routes/auditTokens';
import auditRouter from './routes/audit';
import configRouter from './routes/config';
import auditLogRouter from './routes/auditLog';
import vaultRouter from './routes/vault';
import financeEventsRouter from './routes/financeEvents';
import syncRouter from './routes/sync';
import jobsRouter from './jobs/api';
import searchRouter from './routes/search';
import incomeRouter from './routes/income';
import navStatusRouter from './routes/navStatus';
import { requireAuth } from './auth/middleware';

/**
 * One declarative router mount. The handler chain is applied as
 * `app.use(paths, ...handlers)`, so it supports:
 *   - a single path or an array of paths (multi-path mount),
 *   - a bare-`/api` catch-all (`paths: '/api'`),
 *   - one or more handlers (e.g. `[reportingAuth, reportingRouter]`, or a lone
 *     inline 410 stub).
 */
export interface RouteEntry {
  /** Mount path or paths passed to `app.use(...)`. */
  paths: string | string[];
  /** Handler chain (middleware and/or routers), applied in order. */
  handlers: RequestHandler[];
  /** Why this entry sits where it does — the load-bearing rationale, as data. */
  why?: string;
}

/**
 * Inline 410 Gone stub for the folded personal/corp tax-scenario paths
 * (issue #377). The unified route is /api/tax/scenarios/:kind; the old paths
 * now 410 so any stale caller fails loudly. Kept as a handler (not a router
 * file) to preserve the exact prior inline behavior from app.ts.
 */
const taxScenariosGoneStub: RequestHandler = (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'gone',
    message:
      'This endpoint moved to /api/tax/scenarios/:kind (kind ∈ {personal, corp}).',
  });
};

/**
 * Inline 410 Gone stub for the folded top-level statement-reconciliation path
 * (issue #403). AccountStatement is a period-child of Account, not a parallel
 * primitive, so the surface moved under the Account namespace at
 * /api/accounts/statements. The old /api/statements now 410s so any stale
 * caller fails loudly. Mirrors taxScenariosGoneStub above.
 */
const statementsGoneStub: RequestHandler = (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'gone',
    message: 'This endpoint moved to /api/accounts/statements (issue #403).',
  });
};

/**
 * Capture CORS allow-list, mounted on /api/capture/orders BEFORE the global
 * cors() in app.ts. The global cors uses a static `origin: env.corsOrigin`
 * (the frontend host), which rejects bookmarklet preflights from
 * amazon.{com,ca,co.uk} / reportaproblem.apple.com. We re-export it from the
 * capture route so app.ts can mount it ahead of the global cors middleware.
 *
 * NOTE: this entry is intentionally NOT in `preAuthRoutes` — it must run before
 * the global `cors()` middleware, which itself runs before any registry mount.
 * app.ts mounts it directly in the middleware pipeline; it lives here only so
 * the import graph stays in one place. See app.ts for the mount site.
 */
export { captureCors } from './routes/capture';

/**
 * Routers mounted BEFORE the `app.use('/api', requireAuth)` boundary.
 * These are public or token-authed: health, version, config, auth, client-logs,
 * capture (bookmarklet), the /api/v1 reporting surface (behind reportingAuth),
 * and the audit token/audit surfaces (token-authed in their own routers).
 * ORDER PRESERVED exactly from the prior app.ts sequence.
 */
export const preAuthRoutes: RouteEntry[] = [
  { paths: '/api/health', handlers: [healthRouter], why: 'Public health probe — no auth.' },
  { paths: '/api/version', handlers: [versionRouter], why: 'Public build/version info — no auth.' },
  { paths: '/api/config', handlers: [configRouter], why: 'Public client bootstrap config — no auth.' },
  { paths: '/api/auth', handlers: [authRouter], why: 'Login/register/logout — must be reachable without a session.' },
  { paths: '/api/client-logs', handlers: [clientLogsRouter], why: 'Browser error beacon — accepts logs pre-auth.' },
  { paths: '/api/capture', handlers: [captureRouter], why: 'Bookmarklet capture — token-authed in-router, must sit before requireAuth.' },
  {
    paths: '/api/v1/tokens',
    handlers: [reportingTokensRouter],
    why: 'Reporting token issuance — public surface, mounts before /api/v1 so /tokens wins.',
  },
  {
    paths: '/api/v1',
    handlers: [reportingAuth, reportingRouter],
    why: 'Versioned reporting API — guarded by reportingAuth (token), not session requireAuth.',
  },
  {
    paths: '/api/audit/tokens',
    handlers: [auditTokensRouter],
    why: 'Audit token issuance — mounts before /api/audit so /tokens wins; token-authed.',
  },
  { paths: '/api/audit', handlers: [auditRouter], why: 'Audit ingestion — token-authed in-router; must be pre-session.' },
];

/**
 * Routers mounted AFTER the `app.use('/api', requireAuth)` boundary.
 * Everything here is session-gated. ORDER PRESERVED exactly from the prior
 * app.ts sequence — including specific-before-catchall mounts, the inline 410
 * stub, and the bare-`/api` catch-all routers at the tail.
 */
export const gatedRoutes: RouteEntry[] = [
  { paths: '/api/nav/status', handlers: [navStatusRouter], why: 'Sidebar feature-visibility flags (Phase 1 IA cleanup). Derived read-only counts, no new primitive.' },
  { paths: '/api/jobs', handlers: [jobsRouter] },
  { paths: '/api/search', handlers: [searchRouter] },
  {
    paths: '/api/accounts/statements',
    handlers: [statementsRouter],
    why: 'Statement reconciliation folded under the Account namespace (issue #403): AccountStatement is a period-child of Account, not a parallel primitive. Mounts BEFORE accountsRouter so the specific /accounts/statements path wins against accountsRouter\'s /:id matcher.',
  },
  { paths: '/api/accounts', handlers: [accountsRouter] },
  { paths: '/api/transactions', handlers: [transactionsRouter] },
  { paths: '/api/transfers', handlers: [transfersRouter] },
  {
    paths: '/api/statements',
    handlers: [statementsGoneStub],
    why: 'Old top-level path retained only to return 410 Gone (issue #403) so any stale client surfaces loudly instead of silently breaking. The live surface is /api/accounts/statements above.',
  },
  { paths: '/api/rules', handlers: [rulesRouter] },
  { paths: '/api/contacts', handlers: [contactsRouter] },
  { paths: '/api/categories', handlers: [categoriesRouter] },
  { paths: '/api/labels', handlers: [labelsRouter] },
  { paths: '/api/settlements', handlers: [settlementsRouter] },
  { paths: '/api/partner', handlers: [partnerRouter] },
  { paths: '/api/budgets', handlers: [budgetsRouter] },
  { paths: '/api/insights', handlers: [insightsRouter] },
  { paths: '/api/planned-events', handlers: [plannedEventsRouter] },
  { paths: '/api/monthly-close', handlers: [monthlyCloseRouter] },
  { paths: '/api/calendar', handlers: [calendarRouter] },
  { paths: '/api/goals', handlers: [goalsRouter] },
  { paths: '/api/notifications', handlers: [notificationsRouter] },
  {
    paths: '/api/users/me/notifications',
    handlers: [usersNotificationsRouter],
    why: 'Notification preferences folded under the user namespace (issue #379): live endpoints are /api/users/me/notifications/preferences[/:type].',
  },
  {
    paths: '/api/notification-preferences',
    handlers: [notificationPreferencesRouter],
    why: 'Old standalone path retained only to return 410 Gone (see the route file) so any stale client surfaces loudly instead of silently breaking.',
  },
  { paths: '/api/changelog', handlers: [changelogRouter] },
  { paths: '/api/admin/notifications', handlers: [notificationsAdminRouter] },
  { paths: '/api/forecast', handlers: [forecastRouter] },
  { paths: '/api/debt', handlers: [debtRouter] },
  { paths: '/api/credit-cards', handlers: [creditCardsRouter] },
  { paths: '/api/opportunity-cost', handlers: [opportunityCostRouter] },
  { paths: '/api/financial-scenarios', handlers: [financialScenariosRouter] },
  { paths: '/api/settings/cashflow', handlers: [cashflowSettingsRouter] },
  { paths: '/api/activation-state', handlers: [activationStateRouter] },
  { paths: '/api/saved-filters', handlers: [savedFiltersRouter] },
  { paths: '/api/preferences', handlers: [preferencesRouter] },
  { paths: '/api/onboarding', handlers: [onboardingRouter] },
  { paths: '/api/import', handlers: [importRouter] },
  {
    paths: '/api/summary/sankey',
    handlers: [sankeyRouter],
    why: 'Mounts before summaryRouter so /api/summary/sankey/* wins against any future /:id-style routes added to summaryRouter. The remainder of /api/summary/* keeps flowing to summaryRouter below.',
  },
  { paths: '/api/summary', handlers: [summaryRouter] },
  { paths: '/api/merchants', handlers: [merchantsRouter] },
  { paths: '/api/recurring', handlers: [recurringRouter] },
  { paths: '/api/subscriptions', handlers: [subscriptionsRouter] },
  { paths: '/api/data-quality', handlers: [dataQualityRouter] },
  { paths: '/api/money-leaks', handlers: [moneyLeaksRouter] },
  { paths: '/api/audit-log', handlers: [auditLogRouter] },
  { paths: '/api/vault', handlers: [vaultRouter] },
  { paths: '/api/finance-events', handlers: [financeEventsRouter] },
  { paths: '/api/sync', handlers: [syncRouter] },
  { paths: '/api/reports', handlers: [reportsRouter] },
  {
    paths: '/api/ai',
    handlers: [aiReviewRouter],
    why: 'AI review router (issue #210) mounted BEFORE aiRouter so its /review and /reviews/* paths win against any future overlap. Both share the /api/ai prefix to satisfy the issue endpoint spec.',
  },
  { paths: '/api/cfo', handlers: [cfoBriefingsRouter], why: 'Personal CFO briefings (issue #236).' },
  {
    paths: '/api/review-items',
    handlers: [reviewItemsRouter],
    why: 'Unified read-side fold of all review-item sources (issue #378). Read-only; per-source write endpoints are unchanged.',
  },
  { paths: '/api/ai', handlers: [aiRouter] },
  { paths: '/api/ai', handlers: [aiQueryRouter] },
  { paths: '/api/chat', handlers: [chatRouter] },
  { paths: '/api/amazon', handlers: [amazonRouter] },
  { paths: '/api/external-orders', handlers: [externalOrdersRouter] },
  { paths: '/api/email', handlers: [emailIntegrationsRouter] },
  { paths: '/api/portfolio', handlers: [portfolioRouter] },
  { paths: '/api/dividends', handlers: [dividendsRouter] },
  { paths: '/api/household', handlers: [householdRouter] },
  { paths: '/api/invites', handlers: [invitesRouter] },
  { paths: '/api/net-worth', handlers: [netWorthRouter] },
  { paths: '/api/fx', handlers: [fxRouter] },
  {
    paths: ['/api/tax/personal-scenarios', '/api/tax/corp-scenarios'],
    handlers: [taxScenariosGoneStub],
    why: 'Unified scenario route (issue #377): /api/tax/scenarios/:kind folds the former personal/corp paths. The old paths now return 410 Gone — every internal caller moved to the unified path in the same change.',
  },
  { paths: '/api/tax/scenarios', handlers: [taxScenariosRouter] },
  { paths: '/api/tax/household-plans', handlers: [taxHouseholdPlansRouter] },
  { paths: '/api/tax/reserve', handlers: [taxReserveRouter] },
  { paths: '/api/tax', handlers: [taxRouter] },
  {
    paths: '/api',
    handlers: [businessTaxRouter],
    why: 'businessTaxRouter mounts /business/*, /exports/tax, /tax-tags, and /transactions/:id/tax under /api. Keep it BEFORE other catch-all /api mounts.',
  },
  {
    paths: '/api',
    handlers: [returnWarrantyRouter],
    why: 'returnWarrantyRouter mounts /return-warranty/* and /transactions/:id/return-warranty under /api. Keep BEFORE other catch-all mounts so its specific paths win.',
  },
  { paths: '/api', handlers: [receiptsRouter] },
  { paths: '/api', handlers: [itemsRouter] },
  { paths: '/api', handlers: [purchasesRouter] },
  {
    paths: '/api',
    handlers: [reimbursementsRouter],
    why: 'reimbursementsRouter mounts /reimbursements/* and /transactions/:id/reimbursable under /api (issue #216).',
  },
  {
    paths: '/api',
    handlers: [largePurchaseReviewRouter],
    why: 'largePurchaseReviewRouter mounts /large-purchases/* and /transactions/:id/large-purchase-review under /api (issue #244).',
  },
  {
    paths: '/api',
    handlers: [feedbackRouter],
    why: 'feedbackRouter mounts /feedback and /feedback/:id/resolve under /api (issue #295). Behind the global requireAuth above.',
  },
  { paths: '/api/income', handlers: [incomeRouter] },
];

/**
 * Apply a single entry to the app, preserving the exact `app.use(paths, ...handlers)`
 * call shape. `paths` may be a string or string[]; Express accepts both.
 */
function mountEntry(app: Express, entry: RouteEntry): void {
  // Express's overloads don't accept `string | string[]` in one signature; the
  // runtime handles both. Narrow to satisfy the types without changing behavior.
  if (Array.isArray(entry.paths)) {
    app.use(entry.paths, ...entry.handlers);
  } else {
    app.use(entry.paths, ...entry.handlers);
  }
}

/**
 * Mount the full router registry onto `app`, in order:
 *   1. every `preAuthRoutes` entry (public/token-authed),
 *   2. the `requireAuth` boundary on `/api` (structural — not a list entry),
 *   3. every `gatedRoutes` entry (session-gated).
 *
 * This reproduces the prior app.ts mount order exactly. Call it AFTER the global
 * middleware pipeline (cors, json, attachAuth, withContext) and BEFORE the
 * terminal error handlers.
 */
export function mountRoutes(app: Express): void {
  for (const entry of preAuthRoutes) {
    mountEntry(app, entry);
  }
  app.use('/api', requireAuth);
  for (const entry of gatedRoutes) {
    mountEntry(app, entry);
  }
}

// Touch the Router import so tree-shakers/linters don't flag it; the registry
// composes existing routers rather than constructing new ones, but keeping the
// type available documents that entries are Router-compatible handler chains.
export type { Router };
