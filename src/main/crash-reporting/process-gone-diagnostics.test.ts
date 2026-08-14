import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData,
  collectProcessGoneMetricDetails,
  resetPreGoneProcessMetricsSamplingForTest,
  samplePreGoneProcessMetrics,
  startPreGoneProcessMetricsSampling
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  type: string
  memory: { workingSetSize: number }
}

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => MetricFixture[]>(() => [])
}))

vi.mock('electron', () => ({
  app: {
    getAppMetrics: appMetricsMock
  }
}))

describe('process gone diagnostics', () => {
  beforeEach(() => {
    resetPreGoneProcessMetricsSamplingForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('summarizes Electron process memory by crash-report-friendly buckets', () => {
    const details = collectProcessGoneMetricDetails([
      { pid: 10, type: 'Browser', memory: { workingSetSize: 1024 * 200 } },
      { pid: 11, type: 'Tab', memory: { workingSetSize: 1024 * 750 } },
      { pid: 12, type: 'Renderer', memory: { workingSetSize: 1024 * 125 } },
      { pid: 13, type: 'GPU', memory: { workingSetSize: 1024 * 320 } },
      { pid: 14, type: 'Utility', memory: { workingSetSize: 1024 * 90 } },
      { pid: 15, type: 'Service', memory: { workingSetSize: 1024 * 15 } }
    ])

    expect(details).toEqual({
      processMetricsCount: 6,
      processMetricsBrowserCount: 1,
      processMetricsBrowserWorkingSetMB: 200,
      processMetricsRendererCount: 2,
      processMetricsRendererWorkingSetMB: 875,
      processMetricsGpuCount: 1,
      processMetricsGpuWorkingSetMB: 320,
      processMetricsUtilityCount: 1,
      processMetricsUtilityWorkingSetMB: 90,
      processMetricsOtherCount: 1,
      processMetricsOtherWorkingSetMB: 15,
      processMetricsLargestPid: 11,
      processMetricsLargestType: 'Tab',
      processMetricsLargestWorkingSetMB: 750
    })
  })

  it('flags a renderer-gone record whose live metrics carry only survivors', () => {
    // Field repro (report caf677f2): render-process-gone fires after the OS
    // process exits, so getAppMetrics() enumerates survivors only.
    appMetricsMock.mockReturnValue([
      { pid: 15384, type: 'Browser', memory: { workingSetSize: 1024 * 431 } },
      { pid: 15390, type: 'GPU', memory: { workingSetSize: 1024 * 150 } },
      { pid: 15391, type: 'Utility', memory: { workingSetSize: 1024 * 146 } }
    ])

    expect(buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')).toEqual({
      processType: 'renderer',
      processMetricsCount: 3,
      processMetricsBrowserCount: 1,
      processMetricsBrowserWorkingSetMB: 431,
      processMetricsRendererCount: 0,
      processMetricsRendererWorkingSetMB: 0,
      processMetricsGpuCount: 1,
      processMetricsGpuWorkingSetMB: 150,
      processMetricsUtilityCount: 1,
      processMetricsUtilityWorkingSetMB: 146,
      processMetricsOtherCount: 0,
      processMetricsOtherWorkingSetMB: 0,
      processMetricsLargestPid: 15384,
      processMetricsLargestType: 'Browser',
      processMetricsLargestWorkingSetMB: 431,
      processMetricsCrashedProcessAbsent: true
    })
  })

  it('carries the dead renderer working set from the last pre-gone sample', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    appMetricsMock.mockReturnValue([
      { pid: 15384, type: 'Browser', memory: { workingSetSize: 1024 * 431 } },
      { pid: 15385, type: 'Tab', memory: { workingSetSize: 1024 * 4380 } },
      { pid: 15390, type: 'GPU', memory: { workingSetSize: 1024 * 150 } }
    ])
    samplePreGoneProcessMetrics()

    vi.setSystemTime(1_000_000 + 42_000)
    appMetricsMock.mockReturnValue([
      { pid: 15384, type: 'Browser', memory: { workingSetSize: 1024 * 431 } },
      { pid: 15390, type: 'GPU', memory: { workingSetSize: 1024 * 150 } }
    ])

    expect(buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')).toMatchObject({
      // Live buckets stay survivors-only, and say so.
      processMetricsRendererCount: 0,
      processMetricsRendererWorkingSetMB: 0,
      processMetricsCrashedProcessAbsent: true,
      // The crasher's last known size survives via the pre-gone sample.
      processMetricsPreGoneSampleAgeMs: 42_000,
      processMetricsPreGoneRendererCount: 1,
      processMetricsPreGoneRendererWorkingSetMB: 4380,
      processMetricsPreGoneLargestPid: 15385,
      processMetricsPreGoneLargestType: 'Tab',
      processMetricsPreGoneLargestWorkingSetMB: 4380
    })
  })

  it('refreshes the pre-gone sample on the interval and starts only once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appMetricsMock.mockReturnValue([
      { pid: 30, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    startPreGoneProcessMetricsSampling(1_000)
    startPreGoneProcessMetricsSampling(1_000)

    appMetricsMock.mockReturnValue([
      { pid: 30, type: 'Tab', memory: { workingSetSize: 1024 * 900 } }
    ])
    vi.advanceTimersByTime(1_000)
    appMetricsMock.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 0 } }])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneSampleAgeMs: 0,
      processMetricsPreGoneRendererWorkingSetMB: 900
    })
  })

  it('leaves records unflagged when the crashed bucket is still populated', () => {
    appMetricsMock.mockReturnValue([
      { pid: 21, type: 'Browser', memory: { workingSetSize: 1024 * 100 } },
      { pid: 22, type: 'Tab', memory: { workingSetSize: 1024 * 400 } }
    ])

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')
    expect(details.processMetricsCrashedProcessAbsent).toBeUndefined()
    expect(details.processMetricsRendererWorkingSetMB).toBe(400)
  })

  it('adds process metrics to persisted crash details', () => {
    appMetricsMock.mockReturnValue([
      { pid: 21, type: 'Browser', memory: { workingSetSize: 1024 * 100 } },
      { pid: 22, type: 'Tab', memory: { workingSetSize: 1024 * 400 } }
    ])

    expect(buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')).toMatchObject({
      processType: 'renderer',
      processMetricsCount: 2,
      processMetricsRendererWorkingSetMB: 400,
      processMetricsLargestPid: 22
    })
  })

  it('preserves child process identity on suppressed breadcrumbs', () => {
    expect(
      buildSuppressedProcessGoneBreadcrumbData({
        source: 'child',
        processType: 'Utility',
        reason: 'killed',
        exitCode: 1,
        expectedTeardown: 'app-shutdown',
        details: {
          name: 'Network Service',
          serviceName: 'network.mojom.NetworkService',
          nested: { ignored: true }
        }
      })
    ).toEqual({
      source: 'child',
      processType: 'Utility',
      reason: 'killed',
      exitCode: 1,
      expectedTeardown: 'app-shutdown',
      name: 'Network Service',
      serviceName: 'network.mojom.NetworkService'
    })
  })
})
