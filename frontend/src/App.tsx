import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { Layout } from './components/Layout'
import { AccountsPage } from './pages/AccountsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ImportBatchPage } from './pages/ImportBatchPage'
import { ImportPage } from './pages/ImportPage'
import { PartnerFairnessPage } from './pages/PartnerFairnessPage'
import { ReportsPage } from './pages/ReportsPage'
import { NetWorthPage } from './pages/NetWorthPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { PortfolioSecurityPage } from './pages/PortfolioSecurityPage'
import { PlannedEventsPage } from './pages/PlannedEventsPage'
import { CalendarPage } from './pages/CalendarPage'
import { GoalsPage } from './pages/GoalsPage'
import { ForecastPage } from './pages/ForecastPage'
import { RecurringPage } from './pages/RecurringPage'
import { SubscriptionsPage } from './pages/SubscriptionsPage'
import { ReviewInboxPage } from './pages/ReviewInboxPage'
import { RulesPage } from './pages/RulesPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { ItemsPage } from './pages/ItemsPage'
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
import { BudgetsTab } from './pages/settings/tabs/BudgetsTab'
import { CategoriesTab } from './pages/settings/tabs/CategoriesTab'
import { JobsTab } from './pages/settings/tabs/JobsTab'
import { TaxPage } from './pages/TaxPage'
import { AiInboxPage } from './pages/AiInboxPage'
import { AiReviewsPage } from './pages/AiReviewsPage'
import { InsightsPage } from './pages/InsightsPage'
import { ChatPage } from './pages/ChatPage'
import { AuthProvider } from './lib/auth'
import { useAuth } from './lib/useAuth'
import { ToastProvider } from './components/ui/toast'
import './App.css'

function AppRoutes() {
  const auth = useAuth()
  if (auth.loading) {
    return <main className="authShell"><p className="muted">Loading...</p></main>
  }
  if (!auth.user) return <AuthPage />
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="review" element={<ReviewInboxPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="items" element={<ItemsPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="import/:batchId" element={<ImportBatchPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="portfolio/security/:id" element={<PortfolioSecurityPage />} />
          <Route path="net-worth" element={<NetWorthPage />} />
          <Route path="amazon" element={<AmazonPage />} />
          <Route path="planned" element={<PlannedEventsPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="goals" element={<GoalsPage />} />
          <Route path="forecast" element={<ForecastPage />} />
          <Route path="recurring" element={<RecurringPage />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="partner" element={<PartnerFairnessPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="tax" element={<TaxPage />} />
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
            <Route path="budgets" element={<BudgetsTab />} />
            <Route path="categories" element={<CategoriesTab />} />
            <Route path="jobs" element={<JobsTab />} />
          </Route>
          <Route path="ai/inbox" element={<AiInboxPage />} />
          <Route path="ai/reviews" element={<AiReviewsPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="chat" element={<ChatPage />} />
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
