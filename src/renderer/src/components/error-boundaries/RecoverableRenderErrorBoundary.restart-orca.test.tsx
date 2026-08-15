// @vitest-environment happy-dom

// The "Restart Orca" escape hatch on contained lazy-chunk fallbacks: it must
// only appear when the failure is a stale chunk AND the host can relaunch
// (paired-web hosts without the bridge get no dead button), and a refused
// pre-relaunch checkpoint must re-enable it instead of leaving it stuck.

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyChunkLoadError } from '@/lib/lazy-with-retry'
import { RecoverableRenderErrorBoundary } from './RecoverableRenderErrorBoundary'

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

  it('offers Restart Orca for a contained chunk failure when the host can relaunch', () => {
    const relaunch = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => undefined))
    ;(window as unknown as { api: unknown }).api = { app: { relaunch } }

    renderBoundaryWith(new LazyChunkLoadError(new SyntaxError("Unexpected token '}'")))

    const restart = findRestartButton(container!)
    expect(restart).not.toBeNull()
    expect(container!.textContent).toContain('This part of Orca could not load.')

    act(() => restart?.click())
    expect(relaunch).toHaveBeenCalledTimes(1)
    // Stays disabled while the main-driven relaunch tears the window down.
    expect(restart?.disabled).toBe(true)
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
