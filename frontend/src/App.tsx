import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { Layout } from './components/Layout'
import { AccountsPage } from './pages/AccountsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ReportsPage } from './pages/ReportsPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { RecurringPage } from './pages/RecurringPage'
import { ReviewInboxPage } from './pages/ReviewInboxPage'
import { RulesPage } from './pages/RulesPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { AmazonPage } from './pages/AmazonPage'
import { AuthPage } from './pages/AuthPage'
import { SettingsPage } from './pages/SettingsPage'
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
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="amazon" element={<AmazonPage />} />
          <Route path="recurring" element={<RecurringPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
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
