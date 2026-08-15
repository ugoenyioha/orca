/**
 * The rendered park verdict for one worktree's terminal tabs.
 *
 * Why a pure module: render and the watcher-sync effect must consume the exact
 * same set, and every gate here must stay a function of committed inputs — the
 * activation-deferred coverage answer in particular goes through a latch so the
 * park/reveal lifecycle's own writes can never flip the verdict that caused
 * them (React #185).
 */
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'
import {
  getDeferredParkMaterialKey,
  latchDeferredParkCoverage,
  type DeferredParkCoverageLatch
} from './terminal-activation-deferred-park-latch'

type TerminalOverlayTabAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function selectRenderedParkedTerminalTabIds(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  coldParkTerminalPanes: boolean
  coldParkedTerminalTabIds: ReadonlySet<string>
  sleepingRecordOwnedTabIds: ReadonlySet<string>
  evictionExemptTerminalTabIds: ReadonlySet<string>
  shouldMeasureHiddenWorktree: boolean
  activationDeferredMountTabIds: ReadonlySet<string> | null | undefined
  deferredParkCoverageLatch: DeferredParkCoverageLatch
  deferredParkRestorePolicy: {
    sshParkingEnabled: boolean
    pairedRuntimeParkingEnvironmentIds: ReadonlySet<string>
  }
}): Set<string> {
  const parked = new Set<string>()
  for (const terminalTab of args.terminalTabs) {
    const assignment = args.assignments.get(terminalTab.id)
    const isVisible = Boolean(args.isWorktreeActive && assignment && assignment.isActiveInGroup)
    const hasActivityTerminalPortal =
      findActivityTerminalPortal(args.activityTerminalPortals, {
        worktreeId: args.worktreeId,
        tabId: terminalTab.id
      }) !== null
    if (
      (args.coldParkTerminalPanes ||
        (!isVisible &&
          args.coldParkedTerminalTabIds.has(terminalTab.id) &&
          // Why: a pane owning a sleeping-session record must stay mountable
          // on an active worktree — parked it can never cold-restore, so the
          // agent's resume strands until the user reveals the tab. Scoped to
          // per-tab parks: the worktree-level park clears on activation.
          !args.sleepingRecordOwnedTabIds.has(terminalTab.id))) &&
      !hasActivityTerminalPortal &&
      // Why: a force-parked worktree's eviction-exempt tabs keep their
      // mounted panes — a remount would orphan their live pty. Scoped to
      // force-parks: ordinary parks never contain exempt tabs (eligibility
      // requires every tab restorable, so the memo is empty for them).
      !args.evictionExemptTerminalTabIds.has(terminalTab.id) &&
      // Why: the hidden-measuring startup probe needs mounted panes; gate
      // here too so the reveal lands in the same render that starts it.
      !args.shouldMeasureHiddenWorktree
    ) {
      parked.add(terminalTab.id)
    }
    // Why: activation-deferred tabs render no pane regardless of the park
    // policy, so watchers must own their side effects immediately. Targeted
    // restrictions do not enter this set or add a new eager watcher burst.
    // Why latched: the coverage predicate reads state the park/reveal
    // lifecycle rewrites (captures, layouts), so a per-render re-ask lets the
    // unmount a verdict caused flip the verdict back (React #185); only
    // material identity or restore-policy changes re-open the verdict.
    if (
      args.activationDeferredMountTabIds?.has(terminalTab.id) &&
      !hasActivityTerminalPortal &&
      latchDeferredParkCoverage({
        latch: args.deferredParkCoverageLatch,
        tabId: terminalTab.id,
        materialKey: getDeferredParkMaterialKey(terminalTab, args.deferredParkRestorePolicy),
        evaluateCoverage: () => canWatcherCoverParkedTerminalTab(args.worktreeId, terminalTab)
      })
    ) {
      parked.add(terminalTab.id)
    }
  }
  return parked
}
