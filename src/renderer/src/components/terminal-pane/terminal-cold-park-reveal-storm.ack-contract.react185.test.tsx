/**
 * A/B instrument for the terminal.workbench React #185 crash cluster.
 *
 * Same hostile driver as terminal-cold-park-reveal-storm.react185.test.tsx —
 * watcher sync and pane mounts publish tab titles while the watcher-state
 * feedback flips the legacy coverage verdict — but the watcher-module mock also
 * provides the acknowledged-handoff contract from
 * origin/nwparker/react185-structural-fix (coverage plans with a
 * title-independent materialKey, sync acknowledgements). The plan's materialKey
 * mirrors the real planner's composition (worktree/tab/pty/generation), which
 * provably excludes titles and watcher entries.
 *
 * Expected: FAILS on main (legacy render-time coverage re-ask loops to #185),
 * PASSES on the structural branch (leases hold the verdict across the storm).
 */
/** @vitest-environment happy-dom */
import { act, StrictMode } from 'react'
import type * as ReactModule from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type HarnessTab = {
  id: string
  worktreeId: string
  ptyId: string
  title: string
  generation: number
}

type HarnessUnifiedTab = {
  id: string
  entityId: string
  worktreeId: string
  groupId: string
  contentType: string
  label: string
  customLabel: string | null
  color: string | null
  sortOrder: number
  createdAt: number
}

const harness = vi.hoisted(() => ({
  worktreeId: 'repo::/reveal-storm-ab',
  coverageCalls: 0,
  planCalls: 0,
  syncCalls: 0,
  ackSyncCalls: 0,
  slotRenders: 0,
  slotMounts: 0,
  restoreWrites: 0,
  watcherEntries: new Set<string>(),
  crumbNames: [] as string[]
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    activeGroupIdByWorktree: {} as Record<string, string | undefined>,
    groupsByWorktree: {} as Record<string, unknown[]>,
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, HarnessTab[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    unifiedTabsByWorktree: {} as Record<string, HarnessUnifiedTab[]>,
    consumeSuppressedPtyExit: () => false,
    focusGroup: () => {},
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 2 }),
    setActiveWorktree: () => {}
  }))
  return { useAppStore }
})

vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({})
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string) => {
    harness.crumbNames.push(name)
  }
}))

vi.mock('./TerminalOverlaySlot', async () => {
  const { useEffect } = await vi.importActual<typeof ReactModule>('react')
  const { useAppStore } = await import('../../store')
  type HarnessStoreState = { tabsByWorktree: Record<string, HarnessTab[]> }
  const publishTitle = (tabId: string, title: string): void => {
    ;(
      useAppStore as unknown as {
        setState: (update: (state: HarnessStoreState) => Partial<HarnessStoreState>) => void
      }
    ).setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [harness.worktreeId]: state.tabsByWorktree[harness.worktreeId].map((tab) =>
          tab.id === tabId ? { ...tab, title } : tab
        )
      }
    }))
  }
  return {
    TerminalOverlaySlot: ({ terminalTabId }: { terminalTabId: string }) => {
      harness.slotRenders += 1
      useEffect(() => {
        harness.slotMounts += 1
        if (harness.slotMounts > 400) {
          throw new Error('harness runaway: slot remount storm exceeded 400 mounts')
        }
        publishTitle(terminalTabId, `mounted-${harness.slotMounts}`)
      }, [terminalTabId])
      return null
    }
  }
})

vi.mock('./terminal-parked-tab-watchers', async () => {
  const { useAppStore } = await import('../../store')
  type HarnessStoreState = { tabsByWorktree: Record<string, HarnessTab[]> }
  const publishRestoredTitle = (tabId: string): void => {
    harness.restoreWrites += 1
    ;(
      useAppStore as unknown as {
        setState: (update: (state: HarnessStoreState) => Partial<HarnessStoreState>) => void
      }
    ).setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [harness.worktreeId]: state.tabsByWorktree[harness.worktreeId].map((tab) =>
          tab.id === tabId ? { ...tab, title: `restored-${harness.restoreWrites}` } : tab
        )
      }
    }))
  }
  const reconcileHostileEntries = (args: {
    tabs: readonly { id: string }[]
    parkedTabIds: ReadonlySet<string>
    restoreTitleOnStartTabIds?: ReadonlySet<string>
  }): string[] => {
    const started: string[] = []
    for (const tabId of Array.from(harness.watcherEntries)) {
      if (!args.parkedTabIds.has(tabId)) {
        harness.watcherEntries.delete(tabId)
      }
    }
    for (const tab of args.tabs) {
      if (!args.parkedTabIds.has(tab.id) || harness.watcherEntries.has(tab.id)) {
        continue
      }
      harness.watcherEntries.add(tab.id)
      started.push(tab.id)
      if (args.restoreTitleOnStartTabIds?.has(tab.id)) {
        publishRestoredTitle(tab.id)
      }
    }
    return started
  }
  // Why title-independent: mirrors the real planner's materialKey composition
  // (worktree/tab/pty/generation + pane coverage rows) — the structural fix's
  // load-bearing property is that titles and watcher entries are not material.
  const planFor = (
    worktreeId: string,
    tab: { id: string; ptyId?: string | null; generation?: number | null }
  ): Record<string, unknown> => ({
    status: 'covered',
    materialKey: JSON.stringify([
      'ab-test-plan-v1',
      worktreeId,
      tab.id,
      tab.ptyId ?? null,
      tab.generation ?? null
    ]),
    worktreeId,
    tabId: tab.id,
    tabPtyId: tab.ptyId ?? null,
    generation: tab.generation ?? null,
    panes: [
      {
        ptyId: tab.ptyId ?? null,
        paneId: 1,
        leafId: '11111111-2222-4333-8444-555555555555',
        drivesTabTitle: true
      }
    ]
  })
  return {
    // Legacy render-time predicate (main): watcher-state feedback.
    canWatcherCoverParkedTerminalTab: (_worktreeId: string, tab: { id: string }) => {
      harness.coverageCalls += 1
      return !harness.watcherEntries.has(tab.id)
    },
    planParkedTerminalTabWatcherCoverage: (
      worktreeId: string,
      tab: { id: string; ptyId?: string | null; generation?: number | null }
    ) => {
      harness.planCalls += 1
      return planFor(worktreeId, tab)
    },
    subscribeParkedTerminalWatcherOwnershipLoss: () => () => {},
    disposeParkedTerminalWatchersForWorktree: () => {
      harness.watcherEntries.clear()
    },
    syncParkedTerminalTabWatchers: (args: {
      tabs: readonly { id: string }[]
      parkedTabIds: ReadonlySet<string>
      restoreTitleOnStartTabIds?: ReadonlySet<string>
    }) => {
      harness.syncCalls += 1
      if (harness.syncCalls > 400) {
        throw new Error('harness runaway: watcher sync exceeded 400 reconciliations')
      }
      reconcileHostileEntries(args)
    },
    syncParkedTerminalTabWatchersWithAcknowledgements: (args: {
      worktreeId: string
      tabs: readonly { id: string; ptyId?: string | null }[]
      parkedTabIds: ReadonlySet<string>
      coveragePlansByTabId?: ReadonlyMap<string, { materialKey: string }>
      restoreTitleOnStartTabIds?: ReadonlySet<string>
    }) => {
      harness.ackSyncCalls += 1
      if (harness.ackSyncCalls > 400) {
        throw new Error('harness runaway: ack sync exceeded 400 reconciliations')
      }
      reconcileHostileEntries(args)
      return args.tabs
        .filter((tab) => args.parkedTabIds.has(tab.id))
        .map((tab) => ({
          status: 'covering' as const,
          tabId: tab.id,
          materialKey:
            args.coveragePlansByTabId?.get(tab.id)?.materialKey ??
            (planFor(args.worktreeId, tab).materialKey as string),
          watchedPtyIds: tab.ptyId ? [tab.ptyId] : []
        }))
    }
  }
})

import { useAppStore } from '../../store'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

const DEFERRED_TAB_ID = 'tab-a'
const ACTIVE_TAB_ID = 'tab-b'
const TAB_IDS = [DEFERRED_TAB_ID, ACTIVE_TAB_ID] as const
const GROUP_ID = 'group-a'

const harnessStore = useAppStore as unknown as {
  setState: (partial: Record<string, unknown>) => void
}

function terminalTab(id: string): HarnessTab {
  return {
    id,
    worktreeId: harness.worktreeId,
    ptyId: `${harness.worktreeId}@@session-${id}`,
    title: id,
    generation: 0
  }
}

function unifiedTerminalTab(id: string): HarnessUnifiedTab {
  return {
    id: `unified-${id}`,
    entityId: id,
    worktreeId: harness.worktreeId,
    groupId: GROUP_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('reveal storm under the acknowledged-handoff contract (A/B)', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    harness.coverageCalls = 0
    harness.planCalls = 0
    harness.syncCalls = 0
    harness.ackSyncCalls = 0
    harness.slotRenders = 0
    harness.slotMounts = 0
    harness.restoreWrites = 0
    harness.watcherEntries.clear()
    harness.crumbNames.length = 0
    harnessStore.setState({
      activeGroupIdByWorktree: { [harness.worktreeId]: GROUP_ID },
      groupsByWorktree: {
        [harness.worktreeId]: [
          {
            id: GROUP_ID,
            worktreeId: harness.worktreeId,
            activeTabId: `unified-${ACTIVE_TAB_ID}`,
            tabOrder: TAB_IDS.map((id) => `unified-${id}`),
            recentTabIds: [`unified-${ACTIVE_TAB_ID}`]
          }
        ]
      },
      tabsByWorktree: { [harness.worktreeId]: TAB_IDS.map(terminalTab) },
      unifiedTabsByWorktree: { [harness.worktreeId]: TAB_IDS.map(unifiedTerminalTab) }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    try {
      act(() => root?.unmount())
    } catch {
      // A failed commit leaves no mounted tree to clean up.
    }
    root = undefined
    container.remove()
  })

  it('holds the deferred-tab park verdict through a title-write storm', () => {
    root = createRoot(container)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let thrown: unknown = null
    try {
      act(() => {
        root!.render(
          <StrictMode>
            <TerminalPaneOverlayLayer
              worktreeId={harness.worktreeId}
              worktreePath="reveal-storm-ab"
              isWorktreeActive={true}
              coldParkTerminalPanes={false}
              activationDeferredMountTabIds={new Set([DEFERRED_TAB_ID])}
            />
          </StrictMode>
        )
      })
    } catch (error) {
      thrown = error
    }
    consoleError.mockRestore()

    console.info('[reveal-storm A/B stats]', {
      thrown: thrown instanceof Error ? thrown.message : thrown,
      coverageCalls: harness.coverageCalls,
      planCalls: harness.planCalls,
      syncCalls: harness.syncCalls,
      ackSyncCalls: harness.ackSyncCalls,
      slotMounts: harness.slotMounts,
      restoreWrites: harness.restoreWrites,
      parked: harness.watcherEntries.has(DEFERRED_TAB_ID)
    })
    expect(thrown).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(true)
    expect(harness.syncCalls + harness.ackSyncCalls).toBeLessThan(10)
    // Non-vacuous: the hostile title-write storm must actually have fired.
    expect(harness.restoreWrites).toBeGreaterThan(0)
    expect(harness.slotMounts).toBeGreaterThan(0)
  })
})
