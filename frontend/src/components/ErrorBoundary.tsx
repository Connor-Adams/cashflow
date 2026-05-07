import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clientLogger } from '../lib/clientLogger'

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    clientLogger.error('react_render_error', error, {
      componentStack: info.componentStack,
    })
  }

  render() {
    if (this.state.hasError) {
      return <main className="authShell"><p className="muted">Something went wrong.</p></main>
    }
    return this.props.children
  }
}
