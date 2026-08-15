/**
 * Latched park verdict for activation-deferred terminal tabs.
 *
 * Why: the watcher-coverage predicate reads state the park/reveal lifecycle
 * itself rewrites (pane captures, layouts), so re-asking it on every render
 * lets the unmount a verdict caused flip the verdict back — an update loop the
 * flip-burst pin cannot reach (it only subtracts from the cold-park candidate
 * set). The latch evaluates coverage once per material identity and holds that
 * verdict while the tab stays deferred; only inputs no pane mount/unmount can
 * write — pty identity, generation, restore policy — re-open it.
 */
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export type DeferredParkCoverageLatchEntry = {
  materialKey: string
  covered: boolean
}

export type DeferredParkCoverageLatch = Map<string, DeferredParkCoverageLatchEntry>

export function getDeferredParkMaterialKey(
  terminalTab: Pick<TerminalTab, 'ptyId' | 'generation'>,
  restorePolicy: {
    sshParkingEnabled: boolean
    pairedRuntimeParkingEnvironmentIds: ReadonlySet<string>
  }
): string {
  return JSON.stringify([
    terminalTab.ptyId ?? null,
    terminalTab.generation ?? null,
    restorePolicy.sshParkingEnabled,
    Array.from(restorePolicy.pairedRuntimeParkingEnvironmentIds).sort()
  ])
}

/**
 * Returns the latched verdict, evaluating only when the material key changes.
 * Safe to call during render: idempotent for a given key, including StrictMode
 * double invocation.
 */
export function latchDeferredParkCoverage(args: {
  latch: DeferredParkCoverageLatch
  tabId: string
  materialKey: string
  evaluateCoverage: () => boolean
}): boolean {
  const current = args.latch.get(args.tabId)
  if (current && current.materialKey === args.materialKey) {
    return current.covered
  }
  const covered = args.evaluateCoverage()
  args.latch.set(args.tabId, { materialKey: args.materialKey, covered })
  return covered
}

/** Drops latches for tabs that left the deferred set or no longer exist. */
export function pruneDeferredParkCoverageLatch(
  latch: DeferredParkCoverageLatch,
  deferredTabIds: ReadonlySet<string> | null | undefined,
  liveTabIds: ReadonlySet<string>
): void {
  for (const tabId of Array.from(latch.keys())) {
    if (!deferredTabIds?.has(tabId) || !liveTabIds.has(tabId)) {
      latch.delete(tabId)
    }
  }
}
