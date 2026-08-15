import React from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { advanceLazyChunkRetryEpoch, isLazyChunkLoadError } from '@/lib/lazy-with-retry'
import { reportReactErrorBoundaryCrash } from '@/lib/react-error-boundary-reporting'
import type { ReactErrorBoundaryReportArgs } from '../../../../shared/crash-reporting'
import { translate } from '@/i18n/i18n'

type BoundaryFallbackArgs = {
  error: Error | null
  reset: () => void
}

type Props = {
  boundaryId: string
  surface: ReactErrorBoundaryReportArgs['surface']
  children: React.ReactNode
  className?: string
  compact?: boolean
  reportAsCrash?: boolean
  resetKey?: string | number | boolean | null
  title?: string
  description?: string
  fallback?: (args: BoundaryFallbackArgs) => React.ReactNode
}

type State = {
  error: Error | null
  resetKey: Props['resetKey']
  relaunching: boolean
  relaunchStalled: boolean
}

// How long a clicked relaunch may leave this document alive before the fallback
// takes the buttons back. An Electron relaunch tears the window down ~150ms after
// the IPC resolves; a paired-web relaunch is an in-place reload that a broken
// document can swallow entirely, which would otherwise pin the button disabled.
export const RELAUNCH_SETTLE_GRACE_MS = 5_000

export class RecoverableRenderErrorBoundary extends React.Component<Props, State> {
  state: State = {
    error: null,
    resetKey: this.props.resetKey,
    relaunching: false,
    relaunchStalled: false
  }

  // Sync double-click guard: the second click can reach the handler before the
  // disabled re-render commits, and a doubled app.relaunch() spawns two instances.
  private relaunchRequested = false
  private relaunchSettleTimer: ReturnType<typeof setTimeout> | null = null
  private unmounted = false

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      // A reset abandons the old fallback, so a later error must not inherit its
      // stalled-restart notice ("Try again" would name a button that isn't there).
      return { error: null, resetKey: props.resetKey, relaunchStalled: false }
    }
    return null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(`[${this.props.boundaryId}] render crash contained by boundary`, error, errorInfo)
    if (isLazyChunkLoadError(error)) {
      // Why: lets the next reset (Retry or resetKey) mint a lazy that can load again.
      advanceLazyChunkRetryEpoch()
    }
    if (this.props.reportAsCrash === false) {
      return
    }
    if (isLazyChunkLoadError(error)) {
      // Contained by this fallback; recovery breadcrumbs live on the load path.
      return
    }
    void reportReactErrorBoundaryCrash({
      boundaryId: this.props.boundaryId,
      surface: this.props.surface,
      error,
      errorInfo
    })
  }

  componentWillUnmount(): void {
    this.unmounted = true
    this.clearRelaunchSettleTimer()
  }

  handleReset = (): void => {
    this.setState({ error: null, relaunchStalled: false })
  }

  handleRelaunchApp = (): void => {
    if (this.relaunchRequested) {
      return
    }
    this.relaunchRequested = true
    this.setState({ relaunching: true, relaunchStalled: false })
    void window.api.app.relaunch().then(
      () => {
        // Why: a resolved relaunch that leaves this document alive went nowhere
        // (swallowed in-place reload, teardown that never came); give the
        // buttons back with a notice instead of leaving a dead disabled control.
        // The grace must NOT start while the invoke is still pending — a slow
        // pre-relaunch checkpoint is normal, and re-arming the button mid-invoke
        // could double app.relaunch() into two replacement instances.
        if (!this.unmounted) {
          this.relaunchSettleTimer = setTimeout(
            () => this.markRelaunchStalled(),
            RELAUNCH_SETTLE_GRACE_MS
          )
        }
      },
      (error: unknown) => {
        // Why: a refused pre-relaunch checkpoint keeps the app open; re-enable the button.
        console.error(`[${this.props.boundaryId}] app relaunch failed`, error)
        this.markRelaunchStalled()
      }
    )
  }

  private clearRelaunchSettleTimer(): void {
    if (this.relaunchSettleTimer !== null) {
      clearTimeout(this.relaunchSettleTimer)
      this.relaunchSettleTimer = null
    }
  }

  private markRelaunchStalled(): void {
    this.clearRelaunchSettleTimer()
    this.relaunchRequested = false
    this.setState({ relaunching: false, relaunchStalled: true })
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback({ error: this.state.error, reset: this.handleReset })
    }

    // A contained chunk failure usually means the app updated under this renderer;
    // a main-driven relaunch is the recovery that a swallowed in-place reload isn't.
    const staleChunk = isLazyChunkLoadError(this.state.error)
    const canRelaunch = staleChunk && typeof window.api?.app?.relaunch === 'function'

    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground',
          this.props.compact ? 'min-h-9 py-2' : 'h-full min-h-0 py-8',
          this.props.className
        )}
        role="alert"
      >
        <div className="flex size-8 items-center justify-center rounded-full border border-destructive/25 bg-destructive/10 text-destructive">
          <AlertTriangle className="size-4" />
        </div>
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {this.props.title ??
              (staleChunk
                ? translate(
                    'auto.components.error.boundaries.RecoverableRenderErrorBoundary.staleChunkTitle',
                    'This part of Orca could not load.'
                  )
                : translate(
                    'auto.components.error.boundaries.RecoverableRenderErrorBoundary.ab855c11f4',
                    'This part of Orca hit an error.'
                  ))}
          </div>
          <div className="max-w-md text-xs">
            {this.props.description ??
              (staleChunk
                ? translate(
                    'auto.components.error.boundaries.RecoverableRenderErrorBoundary.staleChunkDescription',
                    'Orca may have updated in the background. Restart Orca to finish applying the update, or retry this part.'
                  )
                : translate(
                    'auto.components.error.boundaries.RecoverableRenderErrorBoundary.34a189ae0f',
                    'The rest of the app is still running. Retry this surface or switch away and come back.'
                  ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canRelaunch ? (
            // A broken document is not the place to recover itself: the main-driven
            // relaunch leads, and the in-place Retry stays as the lighter sibling
            // for the case where assets have already settled.
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={this.state.relaunching}
              onClick={this.handleRelaunchApp}
            >
              {translate(
                'auto.components.error.boundaries.RecoverableRenderErrorBoundary.restartOrca',
                'Restart Orca'
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={canRelaunch ? 'secondary' : 'outline'}
            size="sm"
            disabled={this.state.relaunching}
            onClick={this.handleReset}
          >
            <RotateCw className="size-3.5" />
            {translate(
              'auto.components.error.boundaries.RecoverableRenderErrorBoundary.55001880db',
              'Retry'
            )}
          </Button>
        </div>
        {this.state.relaunchStalled ? (
          <div className="max-w-md text-xs">
            {translate(
              'auto.components.error.boundaries.RecoverableRenderErrorBoundary.restartStalled',
              "Restarting didn't complete. Try again, or retry this part of Orca."
            )}
          </div>
        ) : null}
      </div>
    )
  }
}
