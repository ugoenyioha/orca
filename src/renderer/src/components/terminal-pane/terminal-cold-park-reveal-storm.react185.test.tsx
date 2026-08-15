/**
 * Reproduces the terminal.workbench React #185 crash cluster (reports
 * 05ed75b1 / 996b4cc2 / fe2b1a30, app 1.4.180/1.4.182).
 *
 * The activation-deferred park clause (use-terminal-tab-cold-parking.ts memo)
 * re-asks canWatcherCoverParkedTerminalTab at render time, and the flip-burst
 * pin only subtracts from the cold-park candidate set — deferred-mount churn is
 * "observed and breadcrumbed, not damped" (terminal-park-verdict-flip-telemetry.ts
 * header). When the coverage verdict depends on state the watcher lifecycle
 * itself mutates (capture registry, layouts, runtime titles — all read by
 * resolveParkedTerminalPaneCandidates and written by sync/start/dispose), the
 * verdict alternates per commit: park → watcher start publishes a title →
 * re-render sees no coverage → unpark → pane mount publishes a title →
 * re-render sees coverage → park → … until React throws #185.
 *
 * Every mocked side effect mirrors a real code path:
 * - watcher start restores/publishes tab titles (terminal-parked-tab-watchers.ts:154,
 *   terminal-parked-pty-watcher.ts:124; restoreTitleOnStartTabIds is wired to
 *   the deferred set in use-parked-terminal-watcher-synchronization.ts:146).
 * - pane mount publishes tab titles (reveal repaint / OSC title path).
 * - coverage reads live mutable state (terminal-parked-tab-watchers.ts:87-99).
 * - the deferred set can overlap the mounted set mid-transition — Terminal.tsx's
 *   applyBackgroundMount comment ("a targeted wake can reveal an earlier
 *   activation-deferred tab") defends against exactly that overlap.
 */
/** @vitest-environment happy-dom */
import { act, StrictMode } from 'react'
import type * as ReactModule from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  worktreeId: 'repo::/cold-park-reveal-storm',
  /** Neutralizes the oscillating input: coverage stops reading watcher state. */
  coverageIgnoresWatcherState: false,
  /** Models an uncoverable tab (pty-less leaf / no layout): coverage always denies. */
  coverageDenied: false,
  /** Per-case park policy; {} keeps production 30s timing. */
  parkingOverrides: {} as Record<string, number>,
  coverageCalls: 0,
  syncCalls: 0,
  slotRenders: 0,
  slotMounts: 0,
  restoreWrites: 0,
  watcherEntries: new Set<string>(),
  crumbNames: [] as string[],
  crumbs: [] as { name: string; data?: Record<string, unknown> }[]
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    activeGroupIdByWorktree: {} as Record<string, string | undefined>,
    groupsByWorktree: {} as Record<string, TabGroup[]>,
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, TerminalTab[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    unifiedTabsByWorktree: {} as Record<string, Tab[]>,
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

// Why harness-driven: the deferred-clause cases keep production timing ({}) so
// the cold set stays empty; the runtime-flap case shrinks the hysteresis so the
// cold-set lane engages at all.
vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => harness.parkingOverrides
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: Record<string, unknown>) => {
    harness.crumbNames.push(name)
    harness.crumbs.push({ name, ...(data ? { data } : {}) })
  }
}))

// Why a title write on mount: a revealed pane publishes its tab title (spawn /
// OSC / runtime-title restore), the same store field the parking effect and the
// parked-verdict memo depend on in per-tab mode.
vi.mock('./TerminalOverlaySlot', async () => {
  const { useEffect } = await vi.importActual<typeof ReactModule>('react')
  const { useAppStore } = await import('../../store')
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
  type HarnessStoreState = { tabsByWorktree: Record<string, TerminalTab[]> }
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
  type HarnessStoreState = { tabsByWorktree: Record<string, TerminalTab[]> }
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
  return {
    // Why watcher-state-dependent: the real predicate resolves pane candidates
    // from the capture registry plus terminalLayoutsByTabId/runtimePaneTitlesByTabId
    // — state that watcher start/dispose and the pane lifecycle mutate.
    canWatcherCoverParkedTerminalTab: (_worktreeId: string, tab: { id: string }) => {
      harness.coverageCalls += 1
      if (harness.coverageDenied) {
        return false
      }
      if (harness.coverageIgnoresWatcherState) {
        return true
      }
      return !harness.watcherEntries.has(tab.id)
    },
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
        if (args.restoreTitleOnStartTabIds?.has(tab.id)) {
          publishRestoredTitle(tab.id)
        }
      }
    }
  }
})

import { useAppStore } from '../../store'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

const DEFERRED_TAB_ID = 'tab-a'
const ACTIVE_TAB_ID = 'tab-b'
const TAB_IDS = [DEFERRED_TAB_ID, ACTIVE_TAB_ID] as const
const GROUP_ID = 'group-a'

type HarnessStore = {
  getState: () => Record<string, unknown>
  setState: (partial: Record<string, unknown>) => void
}

const harnessStore = useAppStore as unknown as HarnessStore

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: harness.worktreeId,
    ptyId: `${harness.worktreeId}@@session-${id}`,
    title: id,
    generation: 0
  } as TerminalTab
}

function unifiedTerminalTab(id: string): Tab {
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

function renderRevealStormLayer(
  root: Root,
  options: {
    activationDeferredMountTabIds: ReadonlySet<string> | null
    activityTerminalPortals?: ActivityTerminalPortalTarget[]
  }
): unknown {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let thrown: unknown = null
  try {
    act(() => {
      root.render(
        <StrictMode>
          <TerminalPaneOverlayLayer
            worktreeId={harness.worktreeId}
            worktreePath="cold-park-reveal-storm"
            isWorktreeActive={true}
            coldParkTerminalPanes={false}
            activationDeferredMountTabIds={options.activationDeferredMountTabIds}
            {...(options.activityTerminalPortals
              ? { activityTerminalPortals: options.activityTerminalPortals }
              : {})}
          />
        </StrictMode>
      )
    })
  } catch (error) {
    thrown = error
  }
  consoleError.mockRestore()
  return thrown
}

describe('TerminalPaneOverlayLayer activation-deferred reveal storm', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    harness.coverageIgnoresWatcherState = false
    harness.coverageDenied = false
    harness.parkingOverrides = {}
    harness.crumbs.length = 0
    harness.coverageCalls = 0
    harness.syncCalls = 0
    harness.slotRenders = 0
    harness.slotMounts = 0
    harness.restoreWrites = 0
    harness.watcherEntries.clear()
    harness.crumbNames.length = 0
    const tabs = TAB_IDS.map(terminalTab)
    const unifiedTabs = TAB_IDS.map(unifiedTerminalTab)
    harnessStore.setState({
      settings: {},
      runtimeStatusByEnvironmentId: new Map(),
      activeGroupIdByWorktree: { [harness.worktreeId]: GROUP_ID },
      groupsByWorktree: {
        [harness.worktreeId]: [
          {
            id: GROUP_ID,
            worktreeId: harness.worktreeId,
            activeTabId: `unified-${ACTIVE_TAB_ID}`,
            tabOrder: unifiedTabs.map((tab) => tab.id),
            recentTabIds: [`unified-${ACTIVE_TAB_ID}`]
          }
        ]
      },
      tabsByWorktree: { [harness.worktreeId]: tabs },
      unifiedTabsByWorktree: { [harness.worktreeId]: unifiedTabs }
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

  it('settles a deferred tab whose coverage verdict feeds back through watcher state', () => {
    root = createRoot(container)
    const thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })

    // The crash-cluster loop: park → watcher start title write → coverage flips
    // → unpark → pane mount title write → coverage flips back → park → …
    console.info('[reveal-storm stats]', {
      thrown: thrown instanceof Error ? thrown.message : thrown,
      syncCalls: harness.syncCalls,
      slotMounts: harness.slotMounts,
      restoreWrites: harness.restoreWrites,
      coverageCalls: harness.coverageCalls,
      crumbNames: [...new Set(harness.crumbNames)]
    })
    expect(thrown).toBeNull()
    expect(harness.syncCalls).toBeLessThan(10)
    expect(harness.slotMounts).toBeLessThan(10)
  })

  it('settles when the coverage verdict is independent of watcher state (control)', () => {
    harness.coverageIgnoresWatcherState = true
    root = createRoot(container)
    const thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })

    expect(thrown).toBeNull()
    expect(harness.syncCalls).toBeLessThan(10)
    // Stable coverage keeps the deferred tab parked under watcher ownership.
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(true)
  })

  it('settles with no activation deferral (control)', () => {
    root = createRoot(container)
    const thrown = renderRevealStormLayer(root, { activationDeferredMountTabIds: null })

    expect(thrown).toBeNull()
    expect(harness.syncCalls).toBeLessThan(10)
    expect(harness.watcherEntries.size).toBe(0)
  })

  // Why: the latch must hold the REAL verdict — an uncoverable tab (pty-less
  // leaf / no layout) claimed by watchers would silently drop its bytes.
  it('keeps an uncoverable deferred tab out of watcher ownership', () => {
    harness.coverageDenied = true
    root = createRoot(container)
    const thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })

    expect(thrown).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(false)
    // The unparked tab mounts a pane instead of parking into darkness.
    expect(harness.slotMounts).toBeGreaterThan(0)
    expect(harness.syncCalls).toBeLessThan(10)
  })

  // Why: portal-hosted tabs render through Activity — watcher ownership there
  // would double-attach the pty byte stream.
  it('never claims a portal-hosted deferred tab for watchers', () => {
    root = createRoot(container)
    const portal = {
      slotId: 'slot-1',
      requestToken: 'req-1',
      target: document.createElement('div'),
      worktreeId: harness.worktreeId,
      tabId: DEFERRED_TAB_ID,
      paneKey: 'pane-1',
      active: true
    } as ActivityTerminalPortalTarget
    const thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID]),
      activityTerminalPortals: [portal]
    })

    expect(thrown).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(false)
  })

  // Why: the latch may not outlive deferral — a stale FALSE surviving a
  // reveal → re-defer cycle would leave the re-deferred tab unmounted with no
  // watcher (zero-watcher darkness), the failure the coverage gate exists for.
  it('re-evaluates fresh when a revealed tab is deferred again', () => {
    harness.coverageDenied = true
    root = createRoot(container)
    // Deferred while uncoverable: latched FALSE, no watcher, pane mounts.
    let thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })
    expect(thrown).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(false)

    // Revealed: leaves the deferred set, which prunes its latch entry.
    thrown = renderRevealStormLayer(root, { activationDeferredMountTabIds: null })
    expect(thrown).toBeNull()

    // Re-deferred after coverage returns (same pty/generation/policy → same
    // material key): the verdict must be re-asked, not replayed.
    harness.coverageDenied = false
    harness.coverageIgnoresWatcherState = true
    thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })
    expect(thrown).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(true)
  })

  // Why: the material key must be wired to the LIVE restore policy — the SSH
  // kill switch and paired-runtime capability changes are the documented
  // re-open edges, and each re-key must settle in one evaluation, not loop.
  it('re-opens the latched verdict on restore-policy changes and settles', () => {
    root = createRoot(container)
    const thrown = renderRevealStormLayer(root, {
      activationDeferredMountTabIds: new Set([DEFERRED_TAB_ID])
    })
    expect(thrown).toBeNull()
    // Latched TRUE at deferral entry: watchers own the tab.
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(true)

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let policyThrow: unknown = null
    try {
      // SSH parking kill switch: re-keys the latch; the fresh evaluation sees
      // the watcher-feedback verdict (false) and releases the tab.
      act(() => {
        harnessStore.setState({ settings: { terminalSshViewParking: false } })
      })
    } catch (error) {
      policyThrow = error
    }
    consoleError.mockRestore()
    expect(policyThrow).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(false)

    const syncCallsBeforePairedChange = harness.syncCalls
    const consoleError2 = vi.spyOn(console, 'error').mockImplementation(() => {})
    let pairedThrow: unknown = null
    try {
      // Paired-runtime capability change: re-keys again; coverage now passes
      // (no watcher entry) and the tab returns to watcher ownership.
      act(() => {
        harnessStore.setState({
          runtimeStatusByEnvironmentId: new Map([
            ['env-latch', { status: { capabilities: ['terminal.paired-parking.v1'] } }]
          ])
        })
      })
    } catch (error) {
      pairedThrow = error
    }
    consoleError2.mockRestore()
    expect(pairedThrow).toBeNull()
    expect(harness.watcherEntries.has(DEFERRED_TAB_ID)).toBe(true)
    // Each re-key settles instead of re-entering the storm.
    expect(harness.syncCalls - syncCallsBeforePairedChange).toBeLessThan(10)
    expect(harness.slotMounts).toBeLessThan(20)
  })

  // Field signature from crash 60d84e6d: churn crumbs with trigger=window
  // (flips=38 over ~15s ≈ 2.5/s), migrating across web-terminal tab ids —
  // paired-runtime capability flapping. At that cadence the burst pin
  // (3 flips / 1s) never engages, so the damper watches the thrash without
  // stopping it. External flaps reset React's nested-update counter, so this
  // lane alone remounts panes indefinitely without tripping #185 — the crash
  // needs a commit-synchronous feedback lane (the deferred-clause case above).
  it('paired-runtime status flapping thrashes remounts past the burst pin without #185', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      harness.parkingOverrides = { coldParkDelayMs: 0, hotRetainMs: 0 }
      const environmentId = 'env-1'
      const remoteTab = (id: string): TerminalTab =>
        ({
          id,
          worktreeId: harness.worktreeId,
          ptyId: `remote:${environmentId}@@pty-${id}`,
          title: id,
          generation: 0
        }) as TerminalTab
      const remoteIds = ['tab-r1', 'tab-r2']
      const tabs = [...remoteIds.map(remoteTab), terminalTab(ACTIVE_TAB_ID)]
      const unifiedTabs = [...remoteIds, ACTIVE_TAB_ID].map(unifiedTerminalTab)
      harnessStore.setState({
        groupsByWorktree: {
          [harness.worktreeId]: [
            {
              id: GROUP_ID,
              worktreeId: harness.worktreeId,
              activeTabId: `unified-${ACTIVE_TAB_ID}`,
              tabOrder: unifiedTabs.map((tab) => tab.id),
              recentTabIds: [`unified-${ACTIVE_TAB_ID}`]
            }
          ]
        },
        tabsByWorktree: { [harness.worktreeId]: tabs },
        unifiedTabsByWorktree: { [harness.worktreeId]: unifiedTabs }
      })
      const setPairedCapability = (advertised: boolean): void => {
        harnessStore.setState({
          runtimeStatusByEnvironmentId: new Map([
            [
              environmentId,
              { status: advertised ? { capabilities: ['terminal.paired-parking.v1'] } : null }
            ]
          ])
        })
      }

      root = createRoot(container)
      setPairedCapability(true)
      const thrown = renderRevealStormLayer(root, { activationDeferredMountTabIds: null })
      expect(thrown).toBeNull()

      // Why 1200ms: the burst pin (3 flips/1s) catches evenly-paced sub-second
      // flapping, so a 38-flip window crumb (field report 60d84e6d) implies
      // flips spaced or paired past the burst window — model that pacing.
      let flapThrow: unknown = null
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        for (let flap = 0; flap < 30; flap += 1) {
          vi.setSystemTime(Date.now() + 1200)
          act(() => {
            setPairedCapability(flap % 2 === 0)
          })
        }
      } catch (error) {
        flapThrow = error
      }
      consoleError.mockRestore()

      const churnCrumbs = harness.crumbs.filter(
        (crumb) => crumb.name === 'terminal_park_verdict_churn'
      )
      console.info('[runtime-flap stats]', {
        flapThrow: flapThrow instanceof Error ? flapThrow.message : flapThrow,
        slotMounts: harness.slotMounts,
        syncCalls: harness.syncCalls,
        churn: churnCrumbs.map((crumb) => ({
          trigger: crumb.data?.trigger,
          flips: crumb.data?.flips,
          tabId: crumb.data?.tabId
        }))
      })
      // The flap lane thrashes but does not crash on its own.
      expect(flapThrow).toBeNull()
      // Remount thrash: a pane remounted for many of the OFF flaps.
      expect(harness.slotMounts).toBeGreaterThan(5)
      // The damper saw the churn (window notice) but never pinned it (no burst).
      expect(churnCrumbs.some((crumb) => crumb.data?.trigger === 'window')).toBe(true)
      expect(churnCrumbs.some((crumb) => crumb.data?.trigger === 'burst')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
