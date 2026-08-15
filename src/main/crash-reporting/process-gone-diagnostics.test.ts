import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData,
  collectProcessGoneMetricDetails,
  resetPreGoneProcessMetricsSamplingForTest,
  samplePreGoneProcessMetrics,
  setSystemMemoryInfoReaderForTest,
  startPreGoneProcessMetricsSampling
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  type: string
  memory: { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number }
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
    setSystemMemoryInfoReaderForTest(null)
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

  it('samples at start, refreshes on the interval, and starts only once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appMetricsMock.mockReturnValue([
      { pid: 30, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    startPreGoneProcessMetricsSampling(1_000)
    startPreGoneProcessMetricsSampling(1_000)

    // A crash inside the first interval already has a sample to draw from.
    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneRendererWorkingSetMB: 100
    })

    appMetricsMock.mockClear()
    appMetricsMock.mockReturnValue([
      { pid: 30, type: 'Tab', memory: { workingSetSize: 1024 * 900 } }
    ])
    vi.advanceTimersByTime(1_000)
    // Exactly one sweep: the second start() must not have armed a second timer.
    expect(appMetricsMock).toHaveBeenCalledTimes(1)
    appMetricsMock.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 0 } }])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneSampleAgeMs: 0,
      processMetricsPreGoneRendererWorkingSetMB: 900
    })
  })

  it('keeps the previous pre-gone sample when a sweep fails', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    appMetricsMock.mockReturnValue([
      { pid: 60, type: 'Tab', memory: { workingSetSize: 1024 * 1200 } }
    ])
    samplePreGoneProcessMetrics()

    vi.setSystemTime(2_000_000 + 5_000)
    appMetricsMock.mockImplementationOnce(() => {
      throw new Error('metrics unavailable')
    })
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 0 } }])

    // Sample and its timestamp both survive the failed sweep.
    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneRendererWorkingSetMB: 1200,
      processMetricsPreGoneSampleAgeMs: 5_000
    })
  })

  it('reports the renderer lifetime peak and private bytes when the metrics carry them', () => {
    const details = collectProcessGoneMetricDetails([
      {
        // Larger peak/private than any renderer: proves the fields are
        // renderer-only aggregates, not app-wide maxima.
        pid: 10,
        type: 'Browser',
        memory: {
          workingSetSize: 1024 * 200,
          peakWorkingSetSize: 1024 * 9000,
          privateBytes: 1024 * 8000
        }
      },
      {
        pid: 11,
        type: 'Tab',
        memory: {
          workingSetSize: 1024 * 800,
          peakWorkingSetSize: 1024 * 4100,
          privateBytes: 1024 * 3900
        }
      },
      {
        pid: 12,
        type: 'Tab',
        memory: { workingSetSize: 1024 * 300, peakWorkingSetSize: 1024 * 350 }
      }
    ])

    // Max across renderers, never the Browser's; a spike between interval
    // samples survives in the lifetime peak.
    expect(details.processMetricsRendererPeakWorkingSetMB).toBe(4100)
    expect(details.processMetricsRendererPrivateMB).toBe(3900)
  })

  it('carries the renderer peak through the pre-gone sample after a between-sample spike', () => {
    vi.useFakeTimers()
    vi.setSystemTime(500_000)
    appMetricsMock.mockReturnValue([
      {
        pid: 40,
        type: 'Tab',
        memory: { workingSetSize: 1024 * 800, peakWorkingSetSize: 1024 * 4100 }
      }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 0 } }])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneRendererWorkingSetMB: 800,
      processMetricsPreGoneRendererPeakWorkingSetMB: 4100
    })
  })

  it('keeps plain-prefix peak/private live-only while PreGone carries the cached values', () => {
    // Era invariant: plain prefix = sampled at gone time (survivors), PreGone
    // prefix = cached pre-death sample. Neither may leak into the other.
    appMetricsMock.mockReturnValue([
      {
        pid: 50,
        type: 'Tab',
        memory: {
          workingSetSize: 1024 * 3000,
          peakWorkingSetSize: 1024 * 3300,
          privateBytes: 1024 * 2900
        }
      }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      {
        pid: 51,
        type: 'Tab',
        memory: { workingSetSize: 1024 * 90, peakWorkingSetSize: 1024 * 120 }
      }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsRendererPeakWorkingSetMB).toBe(120)
    expect(details.processMetricsRendererPrivateMB).toBeUndefined()
    expect(details.processMetricsPreGoneRendererPeakWorkingSetMB).toBe(3300)
    expect(details.processMetricsPreGoneRendererPrivateMB).toBe(2900)
  })

  it('reports macOS-shaped system memory and omits the fields macOS lacks', () => {
    // macOS getSystemMemoryInfo() has no swap fields; fileBacked/purgeable are
    // its only reclaimability proxy. Verified on Electron 43.1.0.
    setSystemMemoryInfoReaderForTest(() => ({
      total: 1024 * 65_536,
      free: 1024 * 59,
      fileBacked: 1024 * 21_000,
      purgeable: 1024 * 1_800
    }))

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details).toMatchObject({
      systemMemoryTotalMB: 65_536,
      systemMemoryFreeMB: 59,
      systemMemoryFileBackedMB: 21_000,
      systemMemoryPurgeableMB: 1_800
    })
    expect(details.systemMemorySwapTotalMB).toBeUndefined()
    expect(details.systemMemorySwapFreeMB).toBeUndefined()
  })

  it('samples system memory at gone time but never into the pre-gone snapshot', () => {
    appMetricsMock.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 0 } }])
    samplePreGoneProcessMetrics()
    setSystemMemoryInfoReaderForTest(() => ({
      total: 1024 * 16_384,
      free: 1024 * 210,
      swapTotal: 1024 * 8_192,
      swapFree: 1024 * 40
    }))

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details).toMatchObject({
      systemMemoryTotalMB: 16_384,
      systemMemoryFreeMB: 210,
      systemMemorySwapTotalMB: 8_192,
      systemMemorySwapFreeMB: 40
    })
    expect(details.processMetricsPreGoneSystemMemoryTotalMB).toBeUndefined()
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
