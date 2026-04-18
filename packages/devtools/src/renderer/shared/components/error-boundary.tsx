import React from 'react'
import { Button } from '@/shared/components/ui/button'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * React error boundary that catches rendering errors and displays
 * a fallback UI instead of crashing the entire app.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="text-status-error text-lg mb-2">Something went wrong</div>
          <pre className="text-text-dim text-xs max-w-lg overflow-auto mb-4 p-3 bg-surface-2 rounded border border-border">
            {this.state.error?.message ?? 'Unknown error'}
          </pre>
          <Button onClick={this.handleReset}>
            Try Again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
