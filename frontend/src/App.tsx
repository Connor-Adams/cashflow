import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { Layout } from './components/Layout'
import { AccountsPage } from './pages/AccountsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ImportBatchPage } from './pages/ImportBatchPage'
import { ImportPage } from './pages/ImportPage'
import { PartnerFairnessPage } from './pages/PartnerFairnessPage'
import { ReportsPage } from './pages/ReportsPage'
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
import { TransfersPage } from './pages/TransfersPage'
import { StatementsPage } from './pages/StatementsPage'
import { ItemsPage } from './pages/ItemsPage'
import { PurchasesPage } from './pages/PurchasesPage'
import { AmazonPage } from './pages/AmazonPage'
import { AuthPage } from './pages/AuthPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { SettingsTabLayout } from './pages/settings/SettingsTabLayout'
import { DisplaySection } from './pages/settings/sections/DisplaySection'
import { GmailSection } from './pages/settings/sections/GmailSection'
import { PartnerInviteSection } from './pages/settings/sections/PartnerInviteSection'
import { ImportsTab } from './pages/settings/tabs/ImportsTab'
import { EnrichmentTab } from './pages/settings/tabs/EnrichmentTab'
import { ContactsTab } from './pages/settings/tabs/ContactsTab'
import { MembersTab } from './pages/settings/tabs/MembersTab'
import { BudgetsTab } from './pages/settings/tabs/BudgetsTab'
import { CategoriesTab } from './pages/settings/tabs/CategoriesTab'
import { LabelsTab } from './pages/settings/tabs/LabelsTab'
import { JobsTab } from './pages/settings/tabs/JobsTab'
import { WhatsNewTab } from './pages/settings/tabs/WhatsNewTab'
import { FeedbackInboxTab } from './pages/settings/tabs/FeedbackInboxTab'
import { AuditTokensTab } from './pages/settings/tabs/AuditTokensTab'
import { ReportingTokensTab } from './pages/settings/tabs/ReportingTokensTab'
import { TaxPage } from './pages/TaxPage'
import { IncomePage } from './pages/IncomePage'
import { ReturnWarrantyPage } from './pages/ReturnWarrantyPage'
import { ReimbursementsPage } from './pages/ReimbursementsPage'
import { LargePurchasesPage } from './pages/LargePurchasesPage'
import { UnifiedInboxPage } from './pages/UnifiedInboxPage'
import { InsightsPage } from './pages/InsightsPage'
import { ChatPage } from './pages/ChatPage'
import { AskCashflowPage } from './pages/AskCashflowPage'
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
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="review" element={<ReviewInboxPage />} />
          <Route path="refunds" element={<RefundsReviewPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="statements" element={<StatementsPage />} />
          <Route path="items" element={<ItemsPage />} />
          <Route path="purchases" element={<PurchasesPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="import/:batchId" element={<ImportBatchPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="portfolio/security/:id" element={<PortfolioSecurityPage />} />
          <Route path="net-worth" element={<NetWorthPage />} />
          <Route path="amazon" element={<AmazonPage />} />
          <Route path="planned" element={<PlannedEventsPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="goals" element={<GoalsPage />} />
          <Route path="income" element={<IncomePage />} />
          <Route path="forecast" element={<ForecastPage />} />
          <Route path="debt" element={<DebtPage />} />
          <Route path="credit-cards" element={<CreditCardPlannerPage />} />
          <Route path="opportunity-cost" element={<OpportunityCostPage />} />
          <Route path="scenarios" element={<ScenariosPage />} />
          <Route path="recurring" element={<RecurringPage />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="money-leaks" element={<MoneyLeaksPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="partner" element={<PartnerFairnessPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="sync" element={<SyncPage />} />
          <Route path="reports/explain-month" element={<ExplainMonthPage />} />
          <Route
            path="reports/lifestyle-inflation"
            element={<LifestyleInflationPage />}
          />
          <Route path="reports/savings-rate" element={<SavingsRatePage />} />
          <Route path="sankey" element={<SankeyPage />} />
          <Route path="currency" element={<CurrencyPage />} />
          <Route path="monthly-close" element={<MonthlyClosePage />} />
          <Route path="tax" element={<TaxPage />} />
          <Route path="return-warranty" element={<ReturnWarrantyPage />} />
          <Route path="reimbursements" element={<ReimbursementsPage />} />
          <Route path="large-purchases" element={<LargePurchasesPage />} />
          <Route path="settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="display" replace />} />
            <Route element={<SettingsTabLayout />}>
              <Route path="display" element={<DisplaySection />} />
              <Route path="gmail" element={<GmailSection />} />
              <Route path="partner-invite" element={<PartnerInviteSection />} />
            </Route>
            <Route path="imports" element={<ImportsTab />} />
            <Route path="enrichment" element={<EnrichmentTab />} />
            <Route path="contacts" element={<ContactsTab />} />
            <Route path="members" element={<MembersTab />} />
            <Route path="budgets" element={<BudgetsTab />} />
            <Route path="categories" element={<CategoriesTab />} />
            <Route path="labels" element={<LabelsTab />} />
            <Route path="jobs" element={<JobsTab />} />
            <Route path="whatsnew" element={<WhatsNewTab />} />
            <Route path="feedback" element={<FeedbackInboxTab />} />
            <Route path="audittokens" element={<AuditTokensTab />} />
            <Route path="reportingtokens" element={<ReportingTokensTab />} />
          </Route>
          {/* Unified review-items inbox (issue #378) replaces the separate AI
              inbox / AI reviews / CFO briefings list surfaces. Old routes
              redirect, preselecting the matching saved view. */}
          <Route path="inbox" element={<UnifiedInboxPage />} />
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
          <Route path="insights" element={<InsightsPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="ask" element={<AskCashflowPage />} />
          <Route path="search" element={<SearchPage />} />
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
