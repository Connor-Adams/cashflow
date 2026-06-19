import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { Layout } from './components/Layout'
import { AccountsPage } from './pages/AccountsPage'
import { AccountsLayout, InboxLayout, PlannedLayout, ScenariosLayout, PortfolioLayout } from './pages/RouteTabsLayout'
import { DashboardPage } from './pages/DashboardPage'
import { ImportBatchPage } from './pages/ImportBatchPage'
import { ImportPage } from './pages/ImportPage'
import { ImportsPage } from './pages/ImportsPage'
import { PartnerFairnessPage } from './pages/PartnerFairnessPage'
import { PartnerHomePage } from './pages/PartnerHomePage'
import { ReportsPage } from './pages/ReportsPage'
import { ReportsLayout } from './pages/ReportsLayout'
import { ExplainMonthPage } from './pages/ExplainMonthPage'
import { LifestyleInflationPage } from './pages/LifestyleInflationPage'
import { SavingsRatePage } from './pages/SavingsRatePage'
import { SankeyPage } from './pages/SankeyPage'
import { CurrencyPage } from './pages/CurrencyPage'
import { NetWorthPage } from './pages/NetWorthPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { PortfolioSecurityPage } from './pages/PortfolioSecurityPage'
import { PlannedEventsPage } from './pages/PlannedEventsPage'
import { CalendarPage } from './pages/CalendarPage'
import { GoalsPage } from './pages/GoalsPage'
import { ForecastPage } from './pages/ForecastPage'
import { DebtPage } from './pages/DebtPage'
import { CreditCardPlannerPage } from './pages/CreditCardPlannerPage'
import { OpportunityCostPage } from './pages/OpportunityCostPage'
import { RecurringPage } from './pages/RecurringPage'
import { SubscriptionsPage } from './pages/SubscriptionsPage'
import { MoneyLeaksPage } from './pages/MoneyLeaksPage'
import { MonthlyClosePage } from './pages/MonthlyClosePage'
import { ReviewInboxPage } from './pages/ReviewInboxPage'
import { RefundsReviewPage } from './pages/RefundsReviewPage'
import { RulesPage } from './pages/RulesPage'
import { AuditLogPage } from './pages/AuditLogPage'
import { SyncPage } from './pages/SyncPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { TransactionsLayout } from './pages/TransactionsLayout'
import { TransfersPage } from './pages/TransfersPage'
import { StatementsPage } from './pages/StatementsPage'
import { ItemsPage } from './pages/ItemsPage'
import { PurchasesPage } from './pages/PurchasesPage'
import { ReceiptsPage } from './pages/ReceiptsPage'
import { AuthPage } from './pages/AuthPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { DisplaySection } from './pages/settings/sections/DisplaySection'
import { GmailSection } from './pages/settings/sections/GmailSection'
import { PartnerInviteSection } from './pages/settings/sections/PartnerInviteSection'
import { AppearanceSection } from './pages/settings/sections/AppearanceSection'
import { ImportsTab } from './pages/settings/tabs/ImportsTab'
import { EnrichmentTab } from './pages/settings/tabs/EnrichmentTab'
import { ContactsTab } from './pages/settings/tabs/ContactsTab'
import { MembersTab } from './pages/settings/tabs/MembersTab'
import { BudgetsTab } from './pages/settings/tabs/BudgetsTab'
import { CategoriesTab } from './pages/settings/tabs/CategoriesTab'
import { LabelsTab } from './pages/settings/tabs/LabelsTab'
import { SavedFiltersTab } from './pages/settings/tabs/SavedFiltersTab'
import { JobsTab } from './pages/settings/tabs/JobsTab'
import { WhatsNewTab } from './pages/settings/tabs/WhatsNewTab'
import { FeedbackInboxTab } from './pages/settings/tabs/FeedbackInboxTab'
import { ApiTokensTab } from './pages/settings/tabs/ApiTokensTab'
import { NotificationsTab } from './pages/settings/tabs/NotificationsTab'
import { IncomePage } from './pages/IncomePage'
import { TaxPage } from './pages/TaxPage'
import { ReturnWarrantyPage } from './pages/ReturnWarrantyPage'
import { ReimbursementsPage } from './pages/ReimbursementsPage'
import { PeopleLedgerPage } from './pages/PeopleLedgerPage'
import { LargePurchasesPage } from './pages/LargePurchasesPage'
import { UnifiedInboxPage } from './pages/UnifiedInboxPage'
// InsightsPage kept on disk — route redirects to /inbox?view=insights (Phase 1 IA cleanup)
import { ChatPage } from './pages/ChatPage'
import { SearchPage } from './pages/SearchPage'
import { VaultPage } from './pages/VaultPage'
import { ScenariosPage } from './pages/ScenariosPage'
import { AuthProvider } from './lib/auth'
import { useAuth } from './lib/useAuth'
import { ToastProvider } from './components/ui/toast'
import { OnboardingGate } from './components/onboarding/OnboardingGate'
import './App.css'

function AppRoutes() {
  const auth = useAuth()
  if (auth.loading) {
    return <main className="authShell"><p className="muted">Loading...</p></main>
  }
  if (!auth.user) return <AuthPage />
  return (
    <BrowserRouter>
      {/* First-run onboarding overlay (#259): shows over Dashboard when the
          app has no active accounts and onboarding was never dismissed. */}
      <OnboardingGate />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsLayout />}>
            <Route index element={<AccountsPage />} />
            <Route path="credit-cards" element={<CreditCardPlannerPage />} />
            <Route path="debt" element={<DebtPage />} />
            <Route path="statements" element={<StatementsPage />} />
          </Route>
          <Route path="review" element={<Navigate to="/inbox/review" replace />} />
          <Route path="refunds" element={<Navigate to="/transactions/refunds" replace />} />
          <Route path="transactions" element={<TransactionsLayout />}>
            <Route index element={<TransactionsPage />} />
            <Route path="refunds" element={<RefundsReviewPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="purchases" element={<PurchasesPage />} />
            <Route path="large" element={<LargePurchasesPage />} />
            <Route path="returns" element={<ReturnWarrantyPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="leaks" element={<MoneyLeaksPage />} />
          </Route>
          <Route path="transfers" element={<Navigate to="/transactions/transfers" replace />} />
          <Route path="statements" element={<Navigate to="/accounts/statements" replace />} />
          <Route path="items" element={<Navigate to="/transactions/items" replace />} />
          <Route path="purchases" element={<Navigate to="/transactions/purchases" replace />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="import/:batchId" element={<ImportBatchPage />} />
          <Route path="imports" element={<ImportsPage />} />
          <Route path="portfolio" element={<PortfolioLayout />}>
            <Route index element={<PortfolioPage />} />
            <Route path="net-worth" element={<NetWorthPage />} />
            <Route path="security/:id" element={<PortfolioSecurityPage />} />
          </Route>
          <Route path="net-worth" element={<Navigate to="/portfolio/net-worth" replace />} />
          <Route path="receipts" element={<ReceiptsPage />} />
          <Route path="amazon" element={<Navigate to="/receipts?vendor=amazon" replace />} />
          <Route path="planned" element={<PlannedLayout />}>
            <Route index element={<PlannedEventsPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="forecast" element={<ForecastPage />} />
            <Route path="recurring" element={<RecurringPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="reimbursements" element={<ReimbursementsPage />} />
            <Route path="people" element={<PeopleLedgerPage />} />
          </Route>
          <Route path="calendar" element={<Navigate to="/planned/calendar" replace />} />
          <Route path="goals" element={<GoalsPage />} />
          <Route path="forecast" element={<Navigate to="/planned/forecast" replace />} />
          <Route path="debt" element={<Navigate to="/accounts/debt" replace />} />
          <Route path="credit-cards" element={<Navigate to="/accounts/credit-cards" replace />} />
          <Route path="opportunity-cost" element={<Navigate to="/scenarios/opportunity-cost" replace />} />
          <Route path="scenarios" element={<ScenariosLayout />}>
            <Route index element={<ScenariosPage />} />
            <Route path="tax" element={<TaxPage />} />
            <Route path="opportunity-cost" element={<OpportunityCostPage />} />
          </Route>
          <Route path="recurring" element={<Navigate to="/planned/recurring" replace />} />
          <Route path="subscriptions" element={<Navigate to="/planned/subscriptions" replace />} />
          <Route path="money-leaks" element={<Navigate to="/transactions/leaks" replace />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="partner" element={<Navigate to="/reports/partner" replace />} />
          <Route path="partner-home" element={<PartnerHomePage />} />
          <Route path="reports" element={<ReportsLayout />}>
            <Route index element={<ReportsPage />} />
            <Route path="explain-month" element={<ExplainMonthPage />} />
            <Route path="lifestyle-inflation" element={<LifestyleInflationPage />} />
            <Route path="savings-rate" element={<SavingsRatePage />} />
            <Route path="partner" element={<PartnerFairnessPage />} />
            <Route path="currency" element={<CurrencyPage />} />
            <Route path="cashflow" element={<SankeyPage />} />
          </Route>
          <Route path="audit-log" element={<Navigate to="/settings/audit-log" replace />} />
          <Route path="sync" element={<Navigate to="/settings/backup" replace />} />
          <Route path="sankey" element={<Navigate to="/reports/cashflow" replace />} />
          <Route path="currency" element={<Navigate to="/reports/currency" replace />} />
          <Route path="monthly-close" element={<MonthlyClosePage />} />
          <Route path="income" element={<IncomePage />} />
          <Route path="tax" element={<Navigate to="/scenarios/tax" replace />} />
          <Route path="return-warranty" element={<Navigate to="/transactions/returns" replace />} />
          <Route path="reimbursements" element={<Navigate to="/planned/reimbursements" replace />} />
          <Route path="large-purchases" element={<Navigate to="/transactions/large" replace />} />
          <Route path="settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="display" replace />} />
            <Route path="display" element={<DisplaySection />} />
            <Route path="appearance" element={<AppearanceSection />} />
            <Route path="notifications" element={<NotificationsTab />} />
            <Route path="gmail" element={<GmailSection />} />
            <Route path="partner-invite" element={<PartnerInviteSection />} />
            <Route path="members" element={<MembersTab />} />
            <Route path="categories" element={<CategoriesTab />} />
            <Route path="labels" element={<LabelsTab />} />
            <Route path="contacts" element={<ContactsTab />} />
            <Route path="saved-filters" element={<SavedFiltersTab />} />
            <Route path="imports" element={<ImportsTab />} />
            <Route path="jobs" element={<JobsTab />} />
            <Route path="api-tokens" element={<ApiTokensTab />} />
            <Route path="audit-log" element={<AuditLogPage />} />
            <Route path="backup" element={<SyncPage />} />
            <Route path="feedback" element={<FeedbackInboxTab />} />
            <Route path="whatsnew" element={<WhatsNewTab />} />
            {/* Folded/moved routes — redirect old deep links */}
            <Route path="palette" element={<Navigate to="/settings/appearance" replace />} />
            <Route path="design-system" element={<Navigate to="/settings/appearance" replace />} />
            <Route path="audit-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
            <Route path="reporting-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
            <Route path="budgets" element={<Navigate to="/budgets" replace />} />
            <Route path="enrichment" element={<Navigate to="/enrichment" replace />} />
          </Route>
          {/* Relocated out of Settings (issue: settings junk-drawer) */}
          <Route path="budgets" element={<BudgetsTab />} />
          <Route path="enrichment" element={<EnrichmentTab />} />
          {/* Unified review-items inbox (issue #378) replaces the separate AI
              inbox / AI reviews / CFO briefings list surfaces. Old routes
              redirect, preselecting the matching saved view. */}
          <Route path="inbox" element={<InboxLayout />}>
            <Route index element={<UnifiedInboxPage />} />
            <Route path="review" element={<ReviewInboxPage />} />
          </Route>
          <Route
            path="ai/inbox"
            element={<Navigate to="/inbox?view=ai-suggestions-pending" replace />}
          />
          <Route
            path="ai/reviews"
            element={<Navigate to="/inbox?view=review-queue-pending" replace />}
          />
          <Route
            path="cfo/briefings"
            element={<Navigate to="/inbox?view=cfo-briefings-pending" replace />}
          />
          <Route path="insights" element={<Navigate to="/inbox?view=insights" replace />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="ask" element={<Navigate to="/chat" replace />} />
          <Route path="search" element={<Navigate to="/transactions/search" replace />} />
          <Route path="vault" element={<VaultPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
