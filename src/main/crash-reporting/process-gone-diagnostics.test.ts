import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData,
  collectProcessGoneMetricDetails,
  resetPreGoneProcessMetricsSamplingForTest,
  samplePreGoneProcessMetrics,
  startPreGoneProcessMetricsSampling
} from './process-gone-diagnostics'
import { setSystemMemoryInfoReaderForTest } from './gone-time-system-memory'

type MetricFixture = {
  pid?: number
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
      // Max peak/private sit on the MIDDLE renderer: first-wins and last-wins
      // aggregation bugs both fail here, only a true max passes.
      {
        pid: 11,
        type: 'Tab',
        memory: {
          workingSetSize: 1024 * 300,
          peakWorkingSetSize: 1024 * 350,
          privateBytes: 1024 * 280
        }
      },
      {
        pid: 12,
        type: 'Tab',
        memory: {
          workingSetSize: 1024 * 800,
          peakWorkingSetSize: 1024 * 4100,
          privateBytes: 1024 * 3900
        }
      },
      {
        pid: 13,
        type: 'Tab',
        memory: {
          workingSetSize: 1024 * 400,
          peakWorkingSetSize: 1024 * 900,
          privateBytes: 1024 * 700
        }
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

  it('proves crasher absence by vanished pid when a webview guest keeps the renderer bucket alive', () => {
    // The common case: webviewTag guests / the dashboard popout leave surviving
    // renderers, so the bucket count never hits zero for a main-window crash.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 431 } },
      { pid: 101, type: 'Tab', memory: { workingSetSize: 1024 * 4380 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 300 } }
    ])
    samplePreGoneProcessMetrics()

    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 431 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 300 } }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details).toMatchObject({
      processMetricsRendererCount: 1,
      processMetricsCrashedProcessAbsent: true,
      processMetricsVanishedCount: 1,
      processMetricsVanishedWorkingSetMB: 4380,
      processMetricsVanishedPid: 101
    })
  })

  it('sums multiple vanished same-bucket processes and drops the ambiguous pid', () => {
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 400 } },
      { pid: 101, type: 'Tab', memory: { workingSetSize: 1024 * 2000 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 500 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 400 } }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsVanishedCount).toBe(2)
    expect(details.processMetricsVanishedWorkingSetMB).toBe(2500)
    expect(details.processMetricsVanishedPid).toBeUndefined()
  })

  it('counts a sampled renderer pid as vanished when the OS recycles it into another bucket', () => {
    // Pid reuse: the crasher's pid comes back as a NEW utility process inside
    // the sweep window. A bare live-pid set would read the crasher as alive.
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 400 } },
      { pid: 101, type: 'Tab', memory: { workingSetSize: 1024 * 4380 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 300 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 400 } },
      { pid: 101, type: 'Utility', memory: { workingSetSize: 1024 * 40 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 300 } }
    ])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsCrashedProcessAbsent: true,
      processMetricsVanishedCount: 1,
      processMetricsVanishedWorkingSetMB: 4380,
      processMetricsVanishedPid: 101
    })
  })

  it('bounds an ambiguous vanished sum with the largest single vanished process', () => {
    // Max in the MIDDLE: first-wins and last-wins aggregations both fail here.
    appMetricsMock.mockReturnValue([
      { pid: 101, type: 'Tab', memory: { workingSetSize: 1024 * 500 } },
      { pid: 102, type: 'Tab', memory: { workingSetSize: 1024 * 2000 } },
      { pid: 103, type: 'Tab', memory: { workingSetSize: 1024 * 800 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', memory: { workingSetSize: 1024 * 400 } }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsVanishedWorkingSetMB).toBe(3300)
    expect(details.processMetricsVanishedLargestWorkingSetMB).toBe(2000)
  })

  it('never re-attributes an already-reported vanished pid to a later crash', () => {
    // Crash loop, no sweep in between: record #2 is for the RESPAWNED renderer
    // (never sampled) — it must not inherit the first crasher's pid and size.
    appMetricsMock.mockReturnValue([
      { pid: 200, type: 'Browser', memory: { workingSetSize: 1024 * 400 } },
      { pid: 201, type: 'Tab', memory: { workingSetSize: 1024 * 5000 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 200, type: 'Browser', memory: { workingSetSize: 1024 * 400 } }
    ])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsVanishedPid: 201
    })

    const second = buildProcessGoneCrashDetails({}, 'renderer')
    expect(second.processMetricsVanishedCount).toBeUndefined()
    expect(second.processMetricsVanishedPid).toBeUndefined()
    // Absence still proven by the empty live renderer bucket.
    expect(second.processMetricsCrashedProcessAbsent).toBe(true)
  })

  it('re-arms vanished attribution when a fresh sweep samples the pid alive again', () => {
    // Attribution belongs to the sample it came from: once a new sweep sees
    // the pid alive (respawn or recycle), a later disappearance is reportable.
    appMetricsMock.mockReturnValue([
      { pid: 201, type: 'Tab', memory: { workingSetSize: 1024 * 1000 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([])
    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsVanishedPid: 201
    })

    appMetricsMock.mockReturnValue([
      { pid: 201, type: 'Tab', memory: { workingSetSize: 1024 * 1500 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([])

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsVanishedPid: 201,
      processMetricsVanishedWorkingSetMB: 1500
    })
  })

  it('claims neither absence nor vanished pids when gone-time metrics are unreadable', () => {
    appMetricsMock.mockReturnValue([
      { pid: 300, type: 'Tab', memory: { workingSetSize: 1024 * 900 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockImplementationOnce(() => {
      throw new Error('metrics unavailable')
    })

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsError).toBe('Error')
    // Unreadable metrics prove nothing: no absence flag, no vanished claims.
    expect(details.processMetricsCrashedProcessAbsent).toBeUndefined()
    expect(details.processMetricsVanishedCount).toBeUndefined()
    // The cached pre-gone sample still reaches the record.
    expect(details.processMetricsPreGoneRendererWorkingSetMB).toBe(900)
  })

  it('never counts a sampled pid-less metric as vanished', () => {
    appMetricsMock.mockReturnValue([
      { type: 'Tab', memory: { workingSetSize: 1024 * 50 } },
      { pid: 400, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 400, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsVanishedCount).toBeUndefined()
    expect(details.processMetricsCrashedProcessAbsent).toBeUndefined()
  })

  it('ignores vanished processes outside the crashed bucket', () => {
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Tab', memory: { workingSetSize: 1024 * 600 } },
      { pid: 110, type: 'Utility', memory: { workingSetSize: 1024 * 80 } }
    ])
    samplePreGoneProcessMetrics()
    // The Utility vanished, but the crash under report is a renderer whose
    // process is still enumerable — no absence claim, no Vanished fields.
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Tab', memory: { workingSetSize: 1024 * 600 } }
    ])

    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.processMetricsCrashedProcessAbsent).toBeUndefined()
    expect(details.processMetricsVanishedCount).toBeUndefined()
    expect(details.processMetricsVanishedWorkingSetMB).toBeUndefined()
  })

  it('degrades honestly in a crash loop when the sweep lands between death and respawn', () => {
    // Crash-loop reality check: if a sweep fires while the renderer is dead,
    // the next crash record cannot recover the first crasher's size — but it
    // must say so (zero PreGone renderer fields), never report a stale value
    // as if it were the second crasher's.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    appMetricsMock.mockReturnValue([
      { pid: 200, type: 'Browser', memory: { workingSetSize: 1024 * 400 } },
      { pid: 201, type: 'Tab', memory: { workingSetSize: 1024 * 5000 } }
    ])
    samplePreGoneProcessMetrics()

    // First death: record #1 carries the true pre-death size.
    appMetricsMock.mockReturnValue([
      { pid: 200, type: 'Browser', memory: { workingSetSize: 1024 * 400 } }
    ])
    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneRendererWorkingSetMB: 5000,
      processMetricsVanishedPid: 201
    })

    // Sweep lands while the renderer is dead, overwriting the sample.
    vi.setSystemTime(60_000)
    samplePreGoneProcessMetrics()

    // Second death (respawned pid 202 crashes before any further sweep).
    vi.setSystemTime(62_000)
    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsCrashedProcessAbsent: true,
      processMetricsPreGoneRendererCount: 0,
      processMetricsPreGoneRendererWorkingSetMB: 0,
      processMetricsPreGoneSampleAgeMs: 2_000
    })
  })

  it('clamps a garbage negative working set to zero', () => {
    const details = collectProcessGoneMetricDetails([
      { pid: 10, type: 'Tab', memory: { workingSetSize: -1024 * 50 } },
      { pid: 11, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    expect(details.processMetricsRendererWorkingSetMB).toBe(100)
  })

  it('clamps a garbage negative renderer peak to zero', () => {
    const details = collectProcessGoneMetricDetails([
      {
        pid: 10,
        type: 'Tab',
        memory: { workingSetSize: 1024 * 10, peakWorkingSetSize: -1024 * 90 }
      }
    ])
    expect(details.processMetricsRendererPeakWorkingSetMB).toBe(0)
  })

  it('clamps garbage negative system memory to zero', () => {
    setSystemMemoryInfoReaderForTest(() => ({ free: -1024 * 10, total: 1024 * 16_384 }))
    const details = buildProcessGoneCrashDetails({}, 'renderer')
    expect(details.systemMemoryFreeMB).toBe(0)
    expect(details.systemMemoryTotalMB).toBe(16_384)
  })

  it('rounds working sets to the nearest MB', () => {
    const details = collectProcessGoneMetricDetails([
      { pid: 10, type: 'Tab', memory: { workingSetSize: 1024 * 200 + 700 } }
    ])
    expect(details.processMetricsRendererWorkingSetMB).toBe(201)
  })

  it('clamps the pre-gone sample age when the clock moves backwards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    appMetricsMock.mockReturnValue([
      { pid: 10, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    samplePreGoneProcessMetrics()
    vi.setSystemTime(95_000)

    expect(buildProcessGoneCrashDetails({}, 'renderer')).toMatchObject({
      processMetricsPreGoneSampleAgeMs: 0
    })
  })

  it('lets every metrics-owned key family win over colliding incoming details', () => {
    // Precedence must hold per family — live buckets, system memory, PreGone
    // mirrors, and the absence flag are all written after the incoming spread.
    appMetricsMock.mockReturnValue([
      { pid: 30, type: 'Tab', memory: { workingSetSize: 1024 * 100 } }
    ])
    samplePreGoneProcessMetrics()
    appMetricsMock.mockReturnValue([
      { pid: 21, type: 'Browser', memory: { workingSetSize: 1024 * 100 } }
    ])
    setSystemMemoryInfoReaderForTest(() => ({ free: 1024 * 500 }))

    const details = buildProcessGoneCrashDetails(
      {
        processMetricsCount: 999,
        systemMemoryFreeMB: 999_999,
        processMetricsPreGoneRendererWorkingSetMB: 999_999,
        processMetricsCrashedProcessAbsent: false
      },
      'renderer'
    )
    expect(details.processMetricsCount).toBe(1)
    expect(details.systemMemoryFreeMB).toBe(500)
    expect(details.processMetricsPreGoneRendererWorkingSetMB).toBe(100)
    expect(details.processMetricsCrashedProcessAbsent).toBe(true)
  })

  it("arms an unref'd interval so sampling never holds the event loop open", () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      startPreGoneProcessMetricsSampling(60_000)
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout
      expect(timer.hasRef()).toBe(false)
    } finally {
      setIntervalSpy.mockRestore()
      resetPreGoneProcessMetricsSamplingForTest()
    }
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
