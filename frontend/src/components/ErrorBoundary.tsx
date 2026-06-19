import React, { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@cashflow/ui'
import { clientLogger } from '../lib/clientLogger'

void React

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
  error: Error | null
  errorStack: string | null
}

const MESSAGE_MAX = 100

function truncate(message: string, max = MESSAGE_MAX): string {
  if (message.length <= max) return message
  return message.slice(0, max) + '…'
}

function ErrorBoundaryFallback({
  error,
  errorStack,
}: {
  error: Error
  errorStack: string | null
}): React.JSX.Element {
  const [copyFailed, setCopyFailed] = useState(false)
  const rawMessage = error.message || error.toString() || 'Unknown render error'
  const truncated = truncate(rawMessage)

  async function handleCopy(): Promise<void> {
    const payload = [rawMessage, errorStack ?? error.stack ?? '']
      .filter((s) => s && s.length > 0)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(payload)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
      setTimeout(() => setCopyFailed(false), 2000)
    }
  }

  function handleReload(): void {
    window.location.reload()
  }

  return (
    <main className="authShell">
      <div className="errorBoundaryCard" role="alert">
        <h1>Something broke.</h1>
        <p data-testid="error-boundary-message" className="errorBoundaryMessage">
          {truncated}
        </p>
        <div className="errorBoundaryActions">
          <Button
            type="button"
            variant="secondary"
            onClick={handleReload}
            className="errorBoundaryPrimary"
          >
            Reload page
          </Button>
          <a href="/" className="errorBoundarySecondary">
            Go to Dashboard
          </a>
        </div>
        <div className="errorBoundaryFooter">
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleCopy()}
            className="errorBoundaryCopyLink"
          >
            Copy error details
          </Button>
          {copyFailed && (
            <span className="errorBoundaryCopyFailed" role="status">
              Couldn't copy
            </span>
          )}
        </div>
      </div>
    </main>
  )
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorStack: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorStack: error.stack ?? null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    clientLogger.error('react_render_error', error, {
      componentStack: info.componentStack,
    })
    this.setState({ errorStack: info.componentStack ?? error.stack ?? null })
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <ErrorBoundaryFallback
          error={this.state.error}
          errorStack={this.state.errorStack}
        />
      )
    }
    return this.props.children
  }
}
