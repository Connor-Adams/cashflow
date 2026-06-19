import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { installGlobalClientLogging } from './lib/clientLogger.ts'
import { loadAppConfig } from './lib/appConfig.ts'

installGlobalClientLogging()

// Register the web-push service worker (issue #651). Best-effort: a failure
// here must never block the app from rendering. The worker's only job is the
// `push` / `notificationclick` handlers; the actual subscription is opt-in via
// the dashboard "Enable browser alerts" control.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err)
    })
  })
}

void loadAppConfig().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
