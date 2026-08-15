// @vitest-environment happy-dom

// The "Restart Orca" escape hatch on contained lazy-chunk fallbacks: a broken
// document should not be the one recovering itself, so the main-driven restart
// is the primary action and the in-place Retry its lower-emphasis sibling. It
// must only appear when the failure is a stale chunk AND the host can relaunch,
// a refused pre-relaunch checkpoint must re-enable it, and a relaunch that
// leaves this document alive (swallowed in-place reload on the browser
// fallback host, hung invoke) must give the buttons back after a grace.

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyChunkLoadError } from '@/lib/lazy-with-retry'
import {
  RecoverableRenderErrorBoundary,
  RELAUNCH_SETTLE_GRACE_MS
} from './RecoverableRenderErrorBoundary'

const reportCrashMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function ThrowingChild({ error }: { error: Error }): ReactElement {
  throw error
}

function findRestartButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find(
      (button) => button.textContent?.includes('Restart Orca')
    ) ?? null
  )
}

function findRetryButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find(
      (button) => button.textContent?.includes('Retry')
    ) ?? null
  )
}

describe('RecoverableRenderErrorBoundary Restart Orca button', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    reportCrashMock.mockReset()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    delete (window as unknown as { api?: unknown }).api
    consoleError.mockRestore()
    vi.useRealTimers()
  })

  function renderBoundaryWith(error: Error): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <RecoverableRenderErrorBoundary boundaryId="right-sidebar" surface="right-sidebar">
          <ThrowingChild error={error} />
        </RecoverableRenderErrorBoundary>
      )
    })
  }

  it('offers Restart Orca as the primary action for a contained chunk failure when the host can relaunch', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    expect(restart).not.toBeNull()
    expect(container!.textContent).toContain('This part of Orca could not load.')

    // The main-driven restart leads; the in-place Retry is its lower-emphasis sibling.
    const buttons = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="alert"] button')
    )
    expect(buttons[0]).toBe(restart)
    expect(restart?.dataset.variant).toBe('default')
    const retry = findRetryButton(container!)
    expect(retry?.dataset.variant).toBe('secondary')

    act(() => restart?.click())
    expect(relaunch).toHaveBeenCalledTimes(1)
    // Both stay disabled while the main-driven relaunch tears the window down —
    // a Retry that swaps the surface out mid-checkpoint helps nobody.
    expect(restart?.disabled).toBe(true)
    expect(findRetryButton(container!)?.disabled).toBe(true)
  })

  it('sends one relaunch when Restart Orca is double-clicked before the disabled state commits', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => {
      // Raw dispatch models the second click of a double-click landing before
      // React commits the disabled attribute; a doubled app.relaunch() would
      // spawn two replacement instances.
      const click = (): void => {
        restart?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      click()
      click()
    })
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('gives the buttons back with a notice when the document survives the relaunch grace', async () => {
    vi.useFakeTimers()
    // Browser-fallback host shape: relaunch is an in-place reload that resolves
    // immediately; a broken document can swallow the navigation entirely.
    const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => restart?.click())
    expect(restart?.disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_GRACE_MS + 1)
    })
    expect(findRestartButton(container!)?.disabled).toBe(false)
    expect(findRetryButton(container!)?.disabled).toBe(false)
    expect(container!.textContent).toContain("Restarting didn't complete.")

    // The stall cleared the guard, so a second attempt is a fresh request.
    act(() => findRestartButton(container!)?.click())
    expect(relaunch).toHaveBeenCalledTimes(2)
    expect(container!.textContent).not.toContain("Restarting didn't complete.")
  })

  it('re-enables the button when the pre-relaunch checkpoint refuses', async () => {
    let rejectRelaunch: (error: Error) => void = () => undefined
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRelaunch = reject
      })
    )
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    act(() => restart?.click())
    expect(restart?.disabled).toBe(true)

    await act(async () => {
      rejectRelaunch(new Error('Renderer shutdown checkpoint was not completed.'))
      await Promise.resolve()
    })
    expect(findRestartButton(container!)?.disabled).toBe(false)
  })

  it('hides Restart Orca for ordinary render errors and hosts without relaunch', () => {
    ;(window as unknown as { api: unknown }).api = { app: { relaunch: vi.fn() } }
    renderBoundaryWith(new Error('ordinary render failure'))
    expect(findRestartButton(container!)).toBeNull()
    expect(container!.textContent).toContain('This part of Orca hit an error.')
    // Non-stale errors keep the standalone outline Retry, exactly as before.
    expect(findRetryButton(container!)?.dataset.variant).toBe('outline')
    act(() => root?.unmount())
    root = null
    container?.remove()

    // Paired-web/browser fallback shape: no app bridge at all.
    delete (window as unknown as { api?: unknown }).api
    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))
    expect(container!.querySelector('[role="alert"]')).not.toBeNull()
    expect(findRestartButton(container!)).toBeNull()
  })
})
