import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWorktreeParkingDebugVerdict } from './terminal-parking-e2e-overrides'

const harness = vi.hoisted(() => ({
  census: { managers: 0, panes: 0 },
  crumbs: [] as { name: string; data?: Record<string, unknown> }[]
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: Record<string, unknown>) => {
    harness.crumbs.push({ name, ...(data ? { data } : {}) })
  }
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  getLivePaneCensus: () => harness.census
}))

import {
  recordTerminalWorktreeParkingPass,
  resetTerminalWorktreeParkingPassTelemetry,
  summarizeTerminalWorktreeParkingPass
} from './terminal-worktree-parking-telemetry'

function verdict(
  overrides: Partial<TerminalWorktreeParkingDebugVerdict> & { worktreeId: string }
): TerminalWorktreeParkingDebugVerdict {
  return {
    forceParked: false,
    hasActivityTerminalPortal: false,
    hasPendingSpawnWork: false,
    hiddenSinceMs: null,
    isVisible: false,
    ordinaryParkingCovers: false,
    parkCooldownUntilMs: null,
    shouldMeasureHiddenWorktree: false,
    ...overrides
  }
}

describe('worktree parking pass telemetry', () => {
  beforeEach(() => {
    resetTerminalWorktreeParkingPassTelemetry()
    harness.census = { managers: 49, panes: 60 }
    harness.crumbs.length = 0
  })

  it('summarizes deadline cohorts and vetoes so clock resets and vetoes separate', () => {
    const nowMs = 100 * 60_000
    // Clock-reset shape: hidden but always younger than the 30s park delay.
    const clockReset = summarizeTerminalWorktreeParkingPass({
      verdicts: [
        verdict({ worktreeId: 'a', hiddenSinceMs: nowMs - 10_000 }),
        verdict({ worktreeId: 'b', hiddenSinceMs: nowMs - 25_000 })
      ],
      census: harness.census,
      ordinaryParkedCount: 0,
      nowMs
    })
    expect(clockReset.hiddenTracked).toBe(2)
    expect(clockReset.hiddenPastParkDelay).toBe(0)
    expect(clockReset.oldestHiddenAgeMs).toBe(25_000)

    // Veto shape: long-hidden but blocked at decision time.
    const vetoed = summarizeTerminalWorktreeParkingPass({
      verdicts: [
        verdict({
          worktreeId: 'a',
          hiddenSinceMs: nowMs - 20 * 60_000,
          hasPendingSpawnWork: true
        }),
        verdict({
          worktreeId: 'b',
          hiddenSinceMs: nowMs - 6 * 60_000,
          parkCooldownUntilMs: nowMs + 1_000
        })
      ],
      census: harness.census,
      ordinaryParkedCount: 0,
      nowMs
    })
    expect(vetoed.hiddenPastParkDelay).toBe(2)
    expect(vetoed.hiddenPastHotRetain).toBe(2)
    expect(vetoed.hiddenPastRetentionTtl).toBe(1)
    expect(vetoed.pendingSpawnWork).toBe(1)
    expect(vetoed.cooldown).toBe(1)
    expect(vetoed.managers).toBe(49)
  })

  it('emits once per verdict shift with interval damping, not per pass', () => {
    const base = [verdict({ worktreeId: 'a', hiddenSinceMs: 0 })]
    recordTerminalWorktreeParkingPass({ verdicts: base, ordinaryParkedCount: 0, nowMs: 60_000 })
    expect(harness.crumbs).toHaveLength(1)
    expect(harness.crumbs[0]?.name).toBe('terminal_parking_pass')
    expect(harness.crumbs[0]?.data?.hiddenPastParkDelay).toBe(1)

    // Same cohorts, older age: no re-emit (ages are not part of the key).
    recordTerminalWorktreeParkingPass({ verdicts: base, ordinaryParkedCount: 0, nowMs: 70_000 })
    expect(harness.crumbs).toHaveLength(1)

    // A genuine shift inside the damping window stays pending.
    const shifted = [verdict({ worktreeId: 'a', hiddenSinceMs: 0, hasPendingSpawnWork: true })]
    recordTerminalWorktreeParkingPass({ verdicts: shifted, ordinaryParkedCount: 0, nowMs: 80_000 })
    expect(harness.crumbs).toHaveLength(1)

    // The pending shift fires once the window opens.
    recordTerminalWorktreeParkingPass({ verdicts: shifted, ordinaryParkedCount: 0, nowMs: 95_000 })
    expect(harness.crumbs).toHaveLength(2)
    expect(harness.crumbs[1]?.data?.pendingSpawnWork).toBe(1)
  })

  it('records the manager census with every emission', () => {
    harness.census = { managers: 7, panes: 9 }
    recordTerminalWorktreeParkingPass({ verdicts: [], ordinaryParkedCount: 0, nowMs: 60_000 })
    expect(harness.crumbs[0]?.data?.managers).toBe(7)
    expect(harness.crumbs[0]?.data?.panes).toBe(9)
  })
})
