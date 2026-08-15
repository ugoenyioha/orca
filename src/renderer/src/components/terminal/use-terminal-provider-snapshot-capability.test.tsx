// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  clearTerminalProviderSnapshotCapabilities,
  collectTerminalProviderSnapshotPtyIds,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

type HookStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  pendingReconnectPtyIdByTabId?: Record<string, string>
  terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
}

const storeState: HookStoreState = {
  tabsByWorktree: {
    'repo::worktree': [{ id: 'tab-1', ptyId: 'ssh:target@@pty-1' }]
  },
  ptyIdsByTabId: { 'tab-1': ['ssh:target@@pty-1'] }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useTerminalProviderSnapshotCapability } from './use-terminal-provider-snapshot-capability'

describe('useTerminalProviderSnapshotCapability', () => {
  const resolveCapabilities = vi.fn()

  beforeEach(() => {
    clearTerminalProviderSnapshotCapabilities()
    resolveCapabilities.mockReset()
    ;(window as unknown as { api: unknown }).api = {
      pty: { getAuthoritativeBufferSnapshotCapabilities: resolveCapabilities }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
    delete storeState.pendingReconnectPtyIdByTabId
    delete storeState.terminalLayoutsByTabId
  })

  // Why: synchronization PRUNES cached verdicts outside its collected set, so
  // the ongoing collector must gather the same fields startup does
  // (pending-reconnect and split-leaf layout ptys) or their startup answers
  // decay back into exempt-by-default unknown.
  it('keeps startup verdicts for split-leaf and pending-reconnect ptys alive', async () => {
    storeState.pendingReconnectPtyIdByTabId = { 'tab-2': 'ssh:target@@restored' }
    storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { leaf: 'ssh:target@@split' } }
    }
    const startupResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    await synchronizeTerminalProviderSnapshotCapabilities(
      collectTerminalProviderSnapshotPtyIds(storeState),
      startupResolver
    )
    expect(terminalProviderHasAuthoritativeSnapshot('ssh:target@@split')).toBe(true)
    resolveCapabilities.mockResolvedValue([])

    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await Promise.resolve()

    for (const ptyId of ['ssh:target@@pty-1', 'ssh:target@@split', 'ssh:target@@restored']) {
      expect(terminalProviderHasAuthoritativeSnapshot(ptyId)).toBe(true)
    }
    hook.unmount()
  })

  it('prefetches restored PTYs after render before activation is enabled', async () => {
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])

    renderHook(() => {
      useTerminalProviderSnapshotCapability(false)
      expect(resolveCapabilities).not.toHaveBeenCalled()
    })

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())
    expect(resolveCapabilities).toHaveBeenCalledWith(['ssh:target@@pty-1'])
  })

  it('does not poll again after a provider returns a definitive result', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.runAllTimersAsync()

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('cancels an unknown-capability retry when the hook unmounts', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: null }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapabilities).toHaveBeenCalledOnce()

    hook.unmount()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(resolveCapabilities).toHaveBeenCalledOnce()
  })
})
