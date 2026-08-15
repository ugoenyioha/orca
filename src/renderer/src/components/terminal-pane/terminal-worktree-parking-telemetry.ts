/**
 * Production telemetry for the worktree parking pass.
 *
 * Why: the pass already computes a per-worktree verdict every run and throws
 * it away outside e2e, so a field bundle cannot say WHY hidden worktrees never
 * park — a hiddenSince clock that keeps resetting is indistinguishable from a
 * decision-time veto (pending spawn work, cooldown, coverage). One bounded,
 * change-damped breadcrumb per meaningful shift answers that, alongside the
 * live manager census the same bundles used to infer from crumb multiplicity.
 */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { getLivePaneCensus } from '@/lib/pane-manager/pane-manager-registry'
import { TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS } from './terminal-hidden-worktree-retention'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'
import type { TerminalWorktreeParkingDebugVerdict } from './terminal-parking-e2e-overrides'

export const TERMINAL_PARKING_PASS_BREADCRUMB = 'terminal_parking_pass'
const MIN_EMIT_INTERVAL_MS = 30_000

export type TerminalWorktreeParkingPassSummary = {
  managers: number
  panes: number
  worktrees: number
  hiddenTracked: number
  /** Hidden ages crossing the policy deadlines — the clock-reset discriminator:
   *  a resetting hiddenSince keeps all three at zero forever. */
  hiddenPastParkDelay: number
  hiddenPastHotRetain: number
  hiddenPastRetentionTtl: number
  oldestHiddenAgeMs: number
  visible: number
  measuring: number
  portal: number
  ordinaryParkingCovers: number
  pendingSpawnWork: number
  cooldown: number
  ordinaryParked: number
  forceParked: number
}

export function summarizeTerminalWorktreeParkingPass(args: {
  verdicts: readonly TerminalWorktreeParkingDebugVerdict[]
  census: { managers: number; panes: number }
  ordinaryParkedCount: number
  nowMs: number
}): TerminalWorktreeParkingPassSummary {
  const summary: TerminalWorktreeParkingPassSummary = {
    managers: args.census.managers,
    panes: args.census.panes,
    worktrees: args.verdicts.length,
    hiddenTracked: 0,
    hiddenPastParkDelay: 0,
    hiddenPastHotRetain: 0,
    hiddenPastRetentionTtl: 0,
    oldestHiddenAgeMs: 0,
    visible: 0,
    measuring: 0,
    portal: 0,
    ordinaryParkingCovers: 0,
    pendingSpawnWork: 0,
    cooldown: 0,
    ordinaryParked: args.ordinaryParkedCount,
    forceParked: 0
  }
  for (const verdict of args.verdicts) {
    if (verdict.isVisible) {
      summary.visible += 1
    }
    if (verdict.shouldMeasureHiddenWorktree) {
      summary.measuring += 1
    }
    if (verdict.hasActivityTerminalPortal) {
      summary.portal += 1
    }
    if (verdict.ordinaryParkingCovers) {
      summary.ordinaryParkingCovers += 1
    }
    if (verdict.hasPendingSpawnWork) {
      summary.pendingSpawnWork += 1
    }
    if (verdict.parkCooldownUntilMs != null && args.nowMs < verdict.parkCooldownUntilMs) {
      summary.cooldown += 1
    }
    if (verdict.forceParked) {
      summary.forceParked += 1
    }
    if (verdict.hiddenSinceMs === null || verdict.isVisible) {
      continue
    }
    summary.hiddenTracked += 1
    const ageMs = Math.max(0, args.nowMs - verdict.hiddenSinceMs)
    summary.oldestHiddenAgeMs = Math.max(summary.oldestHiddenAgeMs, ageMs)
    if (ageMs >= TERMINAL_WORKTREE_COLD_PARK_DELAY_MS) {
      summary.hiddenPastParkDelay += 1
    }
    if (ageMs >= TERMINAL_WORKTREE_HOT_RETAIN_MS) {
      summary.hiddenPastHotRetain += 1
    }
    if (ageMs >= TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS) {
      summary.hiddenPastRetentionTtl += 1
    }
  }
  return summary
}

// Why key over counts, not ages: the deadline-cohort counts are the signal and
// change rarely; a raw age in the key would re-emit every pass forever.
function summaryChangeKey(summary: TerminalWorktreeParkingPassSummary): string {
  const { oldestHiddenAgeMs: _oldestHiddenAgeMs, ...keyed } = summary
  return JSON.stringify(keyed)
}

let lastSummaryKey: string | null = null
let lastEmitAtMs = 0

export function resetTerminalWorktreeParkingPassTelemetry(): void {
  lastSummaryKey = null
  lastEmitAtMs = 0
}

/** Records one parking pass; emits a breadcrumb only on a damped verdict shift. */
export function recordTerminalWorktreeParkingPass(args: {
  verdicts: readonly TerminalWorktreeParkingDebugVerdict[]
  ordinaryParkedCount: number
  nowMs: number
}): void {
  const summary = summarizeTerminalWorktreeParkingPass({
    verdicts: args.verdicts,
    census: getLivePaneCensus(),
    ordinaryParkedCount: args.ordinaryParkedCount,
    nowMs: args.nowMs
  })
  const key = summaryChangeKey(summary)
  if (key === lastSummaryKey) {
    return
  }
  // Why keep the last key on damped returns: the shift stays pending and
  // re-fires once the window opens instead of being lost.
  if (lastSummaryKey !== null && args.nowMs - lastEmitAtMs < MIN_EMIT_INTERVAL_MS) {
    return
  }
  lastSummaryKey = key
  lastEmitAtMs = args.nowMs
  recordRendererCrashBreadcrumb(TERMINAL_PARKING_PASS_BREADCRUMB, { ...summary })
}
