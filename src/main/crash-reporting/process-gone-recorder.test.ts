import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessTreeKillWindowForTest } from './process-tree-kill-window'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

type CapturingSink = TracerSink & { records: unknown[]; flushMock: ReturnType<typeof vi.fn> }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  const flushMock = vi.fn()
  return {
    records,
    flushMock,
    push: (record) => records.push(record),
    flush: flushMock,
    close: vi.fn()
  }
}

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

let sink: CapturingSink

beforeEach(() => {
  sink = capturingSink()
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
  resetProcessTreeKillWindowForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('recordProcessGoneCrash', () => {
  it('durably records when the crash report store is unavailable', () => {
    recordProcessGoneCrash(null, event(), new ProcessGoneDedupe())

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'crash_report_store_unavailable',
        data: expect.objectContaining({
          source: 'renderer',
          expectedTeardown: 'none'
        })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('durably records why an expected renderer teardown was suppressed', () => {
    const record = vi.fn()

    recordProcessGoneCrash(
      { record } as never,
      event({ reason: 'killed', exitCode: 1, expectedTeardown: 'renderer-reload' }),
      new ProcessGoneDedupe()
    )

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ expectedTeardown: 'renderer-reload' })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          'breadcrumb.name': 'process_gone_suppressed'
        })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('coalesces a recoverable-service crash loop instead of flushing every event', () => {
    const record = vi.fn()
    const dedupe = new ProcessGoneDedupe()
    const networkServiceCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      expectedTeardown: 'none',
      details: { serviceName: 'network.mojom.NetworkService', type: 'Utility' }
    })

    // Observed peak in a real diagnostic bundle: 1459 suppressed crashes in one minute.
    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash({ record } as never, networkServiceCrash, dedupe)
    }

    expect(record).not.toHaveBeenCalled()
    expect(sink.records).toHaveLength(1)
    expect(sink.flushMock).toHaveBeenCalledOnce()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ serviceName: 'network.mojom.NetworkService' })
      })
    ])
  })

  it('keeps the pre-crash breadcrumb trail through a crash loop', () => {
    const dedupe = new ProcessGoneDedupe()
    recordCrashBreadcrumb('renderer_error', { message: 'boom' })

    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash(
        { record: vi.fn() } as never,
        event({
          source: 'child',
          processType: 'Utility',
          reason: 'crashed',
          details: { serviceName: 'network.mojom.NetworkService' }
        }),
        dedupe
      )
    }

    // Why: the ring holds 30 entries, so an uncoalesced loop evicts every real breadcrumb.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)).toEqual([
      'renderer_error',
      'process_gone_suppressed'
    ])
  })

  it('reports how many repeats a coalesced suppression stands for', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      details: { serviceName: 'network.mojom.NetworkService' }
    })
    const nowSpy = vi.spyOn(Date, 'now')

    nowSpy.mockReturnValue(0)
    for (let i = 0; i < 700; i++) {
      recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)
    }
    nowSpy.mockReturnValue(30_000)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({ name: 'process_gone_suppressed' }),
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ suppressedSinceLast: 699 })
      })
    ])
    // Why: the ring gets this count from the store itself, so only the span proves
    // the exported telemetry carries it too.
    expect(sink.records).toEqual([
      expect.objectContaining({ name: 'crash.breadcrumb' }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.data': expect.objectContaining({ suppressedSinceLast: 699 })
        })
      })
    ])
  })

  it('keeps suppressions with different exit codes separate', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (exitCode: number) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        exitCode,
        details: { serviceName: 'network.mojom.NetworkService' }
      })

    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(11), dedupe)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(139), dedupe)

    // Why: a clean shutdown code and a segfault are different failures; collapsing
    // them would hide the second behind the first for a full window.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.exitCode)).toEqual([
      11, 139
    ])
  })

  it('never lets one recoverable service suppress another service evidence', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (serviceName: string) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        details: { serviceName }
      })

    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('network.mojom.NetworkService'),
      dedupe
    )
    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('audio.mojom.AudioService'),
      dedupe
    )

    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.serviceName)).toEqual([
      'network.mojom.NetworkService',
      'audio.mojom.AudioService'
    ])
  })

  it('persists a report and flushes the process-gone trace before recovery', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        details: expect.objectContaining({
          mainProcessPid: process.pid,
          mainProcessLaunchId: expect.any(String),
          mainProcessStartedAt: expect.any(String)
        })
      })
    )
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'electron.process_gone',
        attributes: expect.objectContaining({
          'app.main_process.pid': process.pid,
          'app.main_process.launch_id': expect.any(String),
          'app.main_process.started_at': expect.any(String)
        }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('still persists the report when the forced trace flush fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.flushMock.mockImplementation(() => {
      throw new Error('trace disk unavailable')
    })

    expect(() =>
      recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('still persists the report when the trace sink handoff fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.push = () => {
      throw new Error('trace rotation failed')
    }

    expect(() =>
      recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('durably records a sanitized crash-report persistence failure', async () => {
    const persistError = Object.assign(
      new Error('EPERM at C:\\Users\\alice\\AppData\\Roaming\\Orca\\crash-reports.json'),
      { code: 'EPERM' }
    )
    const record = vi.fn().mockRejectedValue(persistError)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() => {
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorCode: 'EPERM' })
          })
        ])
      )
    })
    expect(sink.records).toHaveLength(2)
    expect(sink.records[1]).toEqual(
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
    expect(JSON.stringify(sink.records)).not.toContain('alice')
    expect(sink.flushMock).toHaveBeenCalledTimes(2)
  })

  it('keeps null persistence rejections inside the fail-open diagnostic path', async () => {
    const record = vi.fn().mockRejectedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorName: 'object', errorMessage: 'null' })
          })
        ])
      )
    )
  })

  it('allows the same renderer crash to retry after persistence fails', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-2' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), dedupe)
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
      )
    )
    recordProcessGoneCrash({ record } as never, event(), dedupe)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
  })
})

// Field anatomy from the 2026-08-14 sweep: seven v1.4.182 reports where a user
// end-task or an OS shutdown wave killed the whole Electron tree. GPU and the
// Network Service utility die killed/1, the renderer dies killed/1 within the
// same second, expectedTeardown is 'none' in every one — and the renderer kill
// is filed as a crash even though nothing in Orca faulted.
describe('recordProcessGoneCrash whole-process-tree kills', () => {
  const networkServiceKill = event({
    source: 'child',
    processType: 'Utility',
    reason: 'killed',
    exitCode: 1,
    details: {
      name: 'Network Service',
      serviceName: 'network.mojom.NetworkService',
      type: 'Utility'
    }
  })
  const gpuKill = event({
    source: 'child',
    processType: 'GPU',
    reason: 'killed',
    exitCode: 1,
    details: { serviceName: 'GPU', type: 'GPU' }
  })
  const rendererKill = event({ reason: 'killed', exitCode: 1 })

  it('does not report the renderer kill when the children died first', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    const nowSpy = vi.spyOn(Date, 'now')

    nowSpy.mockReturnValue(1_785_708_578_662)
    recordProcessGoneCrash({ record } as never, networkServiceKill, dedupe)
    nowSpy.mockReturnValue(1_785_708_578_737)
    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    nowSpy.mockReturnValue(1_785_708_578_746)
    recordProcessGoneCrash({ record } as never, rendererKill, dedupe)

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'process_gone_suppressed',
          data: expect.objectContaining({ source: 'renderer', siblingKills: 2 })
        })
      ])
    )
  })

  // The same tree kill in the opposite order: the renderer event can land
  // before its children (observed field offsets span -0.08s to +0.10s).
  it('does not report the renderer kill when the children died right after', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    vi.useFakeTimers()
    vi.setSystemTime(1_785_818_589_464)

    recordProcessGoneCrash({ record } as never, rendererKill, dedupe)
    vi.advanceTimersByTime(5)
    recordProcessGoneCrash({ record } as never, networkServiceKill, dedupe)
    vi.advanceTimersByTime(36)
    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    await vi.advanceTimersByTimeAsync(250)

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'process_gone_suppressed',
          data: expect.objectContaining({ source: 'renderer', siblingKills: 2 })
        })
      ])
    )
  })

  it('still reports a solitary renderer kill once the sibling window settles', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    vi.useFakeTimers()

    // Linux SIGKILL of the renderer alone (supervisor OOM-kill style) is a
    // genuine report; no sibling churn means the settle must end in a report.
    recordProcessGoneCrash(
      { record } as never,
      event({ reason: 'killed', exitCode: 9 }),
      new ProcessGoneDedupe()
    )
    expect(record).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(record).toHaveBeenCalledOnce()
  })

  // A kill loop must not become self-suppressing: churn from one iteration
  // ages out of the ±2s window and the next solitary kill still reports.
  it('stops suppressing once the churn ages out of the correlation window', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    vi.useFakeTimers()
    vi.setSystemTime(1_785_818_589_464)

    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    recordProcessGoneCrash({ record } as never, rendererKill, dedupe)
    await vi.advanceTimersByTimeAsync(250)
    expect(record).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    recordProcessGoneCrash({ record } as never, rendererKill, dedupe)
    await vi.advanceTimersByTimeAsync(250)

    expect(record).toHaveBeenCalledOnce()
  })

  it('ignores child kills that died with a different exit code', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    vi.useFakeTimers()

    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    recordProcessGoneCrash({ record } as never, event({ reason: 'killed', exitCode: 9 }), dedupe)
    await vi.advanceTimersByTimeAsync(250)

    expect(record).toHaveBeenCalledOnce()
  })
})
