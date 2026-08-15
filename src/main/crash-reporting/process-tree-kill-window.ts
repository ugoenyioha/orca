import type { ProcessGoneSource } from './process-gone-classification'

// Why: an OS/user kill of the whole Electron tree (Task Manager end-task,
// taskkill /T, session logout, a supervisor SIGKILL) reaches the Chromium
// children and the renderer as independent process-gone events; correlating
// them is the only way to tell that teardown apart from a renderer that died
// on its own. The Windows session-end window cannot cover this: end-task and
// Restart Manager kills deliver no session-end (7/7 v1.4.182 field reports
// filed with expectedTeardown 'none').
export const PROCESS_TREE_KILL_WINDOW_MS = 2_000

// Field offsets between the first and last event of one tree kill run -0.08s
// to +0.10s, so the renderer can arrive before its children; wait this long
// before deciding a renderer kill was solitary.
export const PROCESS_TREE_KILL_SETTLE_MS = 250

// Why: one tree kill produces a handful of events; a deeper ring would only
// let a pre-existing child crash loop outlive the correlation window.
const MAX_TRACKED_KILLS = 16

type TrackedKill = {
  at: number
  source: ProcessGoneSource
  exitCode: number | null
  reason: string
}

let trackedKills: TrackedKill[] = []

export function observeProcessGoneKill(kill: TrackedKill): void {
  // Why: only child kills count as siblings; letting renderer entries into the
  // ring would evict the child evidence a later renderer event needs.
  if (kill.source !== 'child') {
    return
  }
  trackedKills.push(kill)
  if (trackedKills.length > MAX_TRACKED_KILLS) {
    trackedKills = trackedKills.slice(-MAX_TRACKED_KILLS)
  }
}

/** How many Chromium child processes died the same way inside the window — the
 *  signature of the whole tree going down rather than one process failing. */
export function countSiblingProcessTreeKills({
  reason,
  exitCode,
  at = Date.now()
}: {
  reason: string
  exitCode: number | null
  at?: number
}): number {
  return trackedKills.filter(
    (kill) =>
      kill.reason === reason &&
      kill.exitCode === exitCode &&
      Math.abs(at - kill.at) <= PROCESS_TREE_KILL_WINDOW_MS
  ).length
}

export function resetProcessTreeKillWindowForTest(): void {
  trackedKills = []
}
