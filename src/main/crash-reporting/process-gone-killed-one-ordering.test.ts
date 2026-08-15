import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  markSystemSessionEnding,
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope,
  WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
} from './expected-teardown-state'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import {
  PROCESS_TREE_KILL_SETTLE_MS,
  resetProcessTreeKillWindowForTest
} from './process-tree-kill-window'

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

const gpuKill = event({
  source: 'child',
  processType: 'GPU',
  details: { serviceName: 'GPU', type: 'GPU' }
})
const networkServiceKill = event({
  source: 'child',
  processType: 'Utility',
  details: {
    name: 'Network Service',
    serviceName: 'network.mojom.NetworkService',
    type: 'Utility'
  }
})
const rendererKill = event()

function currentTeardownScope() {
  return resolveExpectedTeardownScope({
    isQuitting: false,
    isQuittingForUpdate: false,
    isExpectedRendererReload: false
  })
}

let now: number

beforeEach(() => {
  now = 1_000
  resetExpectedTeardownStateForTest(() => now)
  clearCrashBreadcrumbsForTest()
  resetProcessTreeKillWindowForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetExpectedTeardownStateForTest()
  clearCrashBreadcrumbsForTest()
})

describe('recordProcessGoneCrash killed/1 ordering', () => {
  // Timing changed deliberately: a renderer killed/1 report now persists after a
  // short sibling settle instead of synchronously, because a tree kill can reach
  // the renderer before its children. A solitary kill must still end in a report.
  it('reports a genuine lone renderer killed/1 without teardown intent', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    vi.useFakeTimers()

    recordProcessGoneCrash({ record } as never, rendererKill, new ProcessGoneDedupe())
    await vi.advanceTimersByTimeAsync(PROCESS_TREE_KILL_SETTLE_MS)

    expect(record).toHaveBeenCalledOnce()
  })

  // FLIPPED (previously asserted the renderer report survives sibling churn).
  // Field evidence overturned that policy: all 7 false killed/1 reports from the
  // 2026-08-14 sweep ran v1.4.182 — which already had the session-end window —
  // and every one showed exactly this GPU+utility churn in the same second with
  // expectedTeardown 'none'. End-task and Restart Manager kills never deliver
  // session-end, so matching sibling churn is teardown evidence, not noise.
  it('suppresses R3 after matching recoverable sibling churn', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()

    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    recordProcessGoneCrash({ record } as never, networkServiceKill, dedupe)
    recordProcessGoneCrash({ record } as never, rendererKill, dedupe)

    expect(record).not.toHaveBeenCalled()
  })

  it('suppresses the fleet sequence after independent session-end intent', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    markSystemSessionEnding()
    const expectedTeardown = currentTeardownScope()

    recordProcessGoneCrash({ record } as never, event({ ...gpuKill, expectedTeardown }), dedupe)
    recordProcessGoneCrash(
      { record } as never,
      event({ ...networkServiceKill, expectedTeardown }),
      dedupe
    )
    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown }),
      dedupe
    )

    expect(expectedTeardown).toBe('app-shutdown')
    expect(record).not.toHaveBeenCalled()
  })

  // Timing changed deliberately: persistence now waits out the sibling settle
  // (see the lone-kill test above); the session-end expiry contract is unchanged.
  it('durably reports killed/1 after the session-end window expires', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    vi.useFakeTimers()
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const expectedTeardown = currentTeardownScope()

    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown }),
      new ProcessGoneDedupe()
    )
    await vi.advanceTimersByTimeAsync(PROCESS_TREE_KILL_SETTLE_MS)

    expect(expectedTeardown).toBe('none')
    expect(record).toHaveBeenCalledOnce()
  })

  // Timing changed deliberately: same sibling-settle deferral as above; the
  // report filed before session-end intent existed must still be filed.
  it('keeps a renderer report filed when session-end intent arrives later', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    vi.useFakeTimers()
    const scopeBeforeSessionEnd = currentTeardownScope()

    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown: scopeBeforeSessionEnd }),
      new ProcessGoneDedupe()
    )
    await vi.advanceTimersByTimeAsync(PROCESS_TREE_KILL_SETTLE_MS)
    markSystemSessionEnding()
    const scopeAfterSessionEnd = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown: scopeAfterSessionEnd }),
      new ProcessGoneDedupe()
    )
    await vi.advanceTimersByTimeAsync(PROCESS_TREE_KILL_SETTLE_MS)

    expect(scopeBeforeSessionEnd).toBe('none')
    expect(scopeAfterSessionEnd).toBe('app-shutdown')
    expect(record).toHaveBeenCalledOnce()
  })
})
