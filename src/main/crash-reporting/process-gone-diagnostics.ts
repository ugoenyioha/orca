import { app } from 'electron'
import {
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData,
  type CrashReportDetailValue
} from '../../shared/crash-reporting'
import type { ExpectedTeardownScope } from './process-gone-classification'
import { getSystemMemoryAtGoneDetails, memoryKBFieldMB } from './gone-time-system-memory'

type ProcessMetricLike = {
  pid?: unknown
  type?: unknown
  memory?: {
    workingSetSize?: unknown
    peakWorkingSetSize?: unknown
    privateBytes?: unknown
  } | null
}
type CrashReportDetails = Record<string, CrashReportDetailValue>

type ProcessMetricBucket = {
  count: number
  workingSetMB: number
}

const PROCESS_METRIC_BUCKETS = ['browser', 'renderer', 'gpu', 'utility', 'other'] as const

type ProcessMetricBucketName = (typeof PROCESS_METRIC_BUCKETS)[number]

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function metricTypeBucket(type: unknown): ProcessMetricBucketName {
  const normalized = safeString(type)?.toLowerCase()
  if (normalized === 'browser') {
    return 'browser'
  }
  if (normalized === 'renderer' || normalized === 'tab') {
    return 'renderer'
  }
  if (normalized === 'gpu') {
    return 'gpu'
  }
  if (normalized === 'utility') {
    return 'utility'
  }
  return 'other'
}

function workingSetMB(metric: ProcessMetricLike): number {
  const workingSetKB = safeFiniteNumber(metric.memory?.workingSetSize) ?? 0
  return Math.round(Math.max(0, workingSetKB) / 1024)
}

function emptyBuckets(): Record<ProcessMetricBucketName, ProcessMetricBucket> {
  return {
    browser: { count: 0, workingSetMB: 0 },
    renderer: { count: 0, workingSetMB: 0 },
    gpu: { count: 0, workingSetMB: 0 },
    utility: { count: 0, workingSetMB: 0 },
    other: { count: 0, workingSetMB: 0 }
  }
}

function titleCaseBucket(bucket: ProcessMetricBucketName): string {
  return `${bucket[0].toUpperCase()}${bucket.slice(1)}`
}

export function collectProcessGoneMetricDetails(metrics: ProcessMetricLike[]): CrashReportDetails {
  const buckets = emptyBuckets()
  let largest: { pid: number; type: string; workingSetMB: number } | null = null
  // Why peak/private only for renderers: a spike between interval samples still
  // shows in the lifetime peak, and private-vs-shared separates real commit
  // from mapped memory — both matter for OOM triage, not for other buckets.
  let rendererPeakWorkingSetMB: number | null = null
  let rendererPrivateMB: number | null = null

  for (const metric of metrics) {
    const bucketName = metricTypeBucket(metric.type)
    const bucket = buckets[bucketName]
    const metricWorkingSetMB = workingSetMB(metric)
    bucket.count += 1
    bucket.workingSetMB += metricWorkingSetMB
    if (bucketName === 'renderer') {
      const peakMB = memoryKBFieldMB(metric.memory?.peakWorkingSetSize)
      if (peakMB !== undefined) {
        rendererPeakWorkingSetMB = Math.max(rendererPeakWorkingSetMB ?? 0, peakMB)
      }
      const privateMB = memoryKBFieldMB(metric.memory?.privateBytes)
      if (privateMB !== undefined) {
        rendererPrivateMB = Math.max(rendererPrivateMB ?? 0, privateMB)
      }
    }
    const pid = safeFiniteNumber(metric.pid) ?? 0
    if (!largest || metricWorkingSetMB > largest.workingSetMB) {
      largest = {
        pid,
        type: safeString(metric.type) ?? 'unknown',
        workingSetMB: metricWorkingSetMB
      }
    }
  }

  const details: CrashReportDetails = { processMetricsCount: metrics.length }
  for (const bucketName of PROCESS_METRIC_BUCKETS) {
    const label = titleCaseBucket(bucketName)
    details[`processMetrics${label}Count`] = buckets[bucketName].count
    details[`processMetrics${label}WorkingSetMB`] = buckets[bucketName].workingSetMB
  }
  if (rendererPeakWorkingSetMB !== null) {
    details.processMetricsRendererPeakWorkingSetMB = rendererPeakWorkingSetMB
  }
  if (rendererPrivateMB !== null) {
    details.processMetricsRendererPrivateMB = rendererPrivateMB
  }
  if (largest) {
    details.processMetricsLargestPid = largest.pid
    details.processMetricsLargestType = largest.type
    details.processMetricsLargestWorkingSetMB = largest.workingSetMB
  }
  return details
}

type LiveProcessGoneMetrics = {
  details: CrashReportDetails
  // null = metrics unreadable, so pid-level absence cannot be proven.
  pids: Set<number> | null
}

function getLiveProcessGoneMetrics(): LiveProcessGoneMetrics {
  try {
    const metrics = app.getAppMetrics()
    const pids = new Set<number>()
    for (const metric of metrics) {
      const pid = safeFiniteNumber(metric.pid)
      if (pid !== undefined) {
        pids.add(pid)
      }
    }
    return { details: collectProcessGoneMetricDetails(metrics), pids }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error
    return { details: { processMetricsError: errorName }, pids: null }
  }
}

// ─── Pre-gone metric sampling ───────────────────────────────────────
// Why: process-gone fires after the crashed process left Chromium's registry,
// so gone-time getAppMetrics() only sees survivors — field reports carried
// processMetricsRendererCount=0 for every renderer death. A periodic sample
// keeps the last pre-death working sets so the crasher's size survives it.

export const PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS = 60_000

type PreGoneSampledProcess = {
  pid: number
  bucket: ProcessMetricBucketName
  workingSetMB: number
}

type PreGoneProcessMetricsSample = {
  details: CrashReportDetails
  processes: PreGoneSampledProcess[]
  sampledAtMs: number
}

let preGoneSample: PreGoneProcessMetricsSample | null = null
let preGoneSampleTimer: ReturnType<typeof setInterval> | null = null

function sampledProcessIdentities(metrics: ProcessMetricLike[]): PreGoneSampledProcess[] {
  const processes: PreGoneSampledProcess[] = []
  for (const metric of metrics) {
    const pid = safeFiniteNumber(metric.pid)
    if (pid === undefined) {
      continue
    }
    processes.push({
      pid,
      bucket: metricTypeBucket(metric.type),
      workingSetMB: workingSetMB(metric)
    })
  }
  return processes
}

export function samplePreGoneProcessMetrics(nowMs: number = Date.now()): void {
  try {
    const metrics = app.getAppMetrics()
    preGoneSample = {
      details: collectProcessGoneMetricDetails(metrics),
      processes: sampledProcessIdentities(metrics),
      sampledAtMs: nowMs
    }
  } catch {
    // Why: a failed sweep must not erase the previous good sample.
  }
}

export function startPreGoneProcessMetricsSampling(
  intervalMs: number = PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS
): void {
  if (preGoneSampleTimer) {
    return
  }
  samplePreGoneProcessMetrics()
  preGoneSampleTimer = setInterval(() => samplePreGoneProcessMetrics(), intervalMs)
  preGoneSampleTimer.unref?.()
}

export function resetPreGoneProcessMetricsSamplingForTest(): void {
  if (preGoneSampleTimer) {
    clearInterval(preGoneSampleTimer)
  }
  preGoneSampleTimer = null
  preGoneSample = null
}

const PROCESS_METRICS_KEY_PREFIX = 'processMetrics'

function preGoneSampleDetails(
  sample: PreGoneProcessMetricsSample,
  nowMs: number
): CrashReportDetails {
  const details: CrashReportDetails = {
    processMetricsPreGoneSampleAgeMs: Math.max(0, nowMs - sample.sampledAtMs)
  }
  for (const [key, value] of Object.entries(sample.details)) {
    details[`${PROCESS_METRICS_KEY_PREFIX}PreGone${key.slice(PROCESS_METRICS_KEY_PREFIX.length)}`] =
      value
  }
  return details
}

export function buildProcessGoneCrashDetails(
  details: Record<string, unknown>,
  crashedProcessType: string
): CrashReportDetails {
  const sanitizedDetails = sanitizeCrashReportDetails(details)
  // Why: low-JS-heap renderer kills can still be native/process memory pressure.
  // Capture Electron process buckets at process-gone time before recovery reloads.
  const { details: liveMetricDetails, pids: livePids } = getLiveProcessGoneMetrics()
  const crashDetails: CrashReportDetails = {
    ...sanitizedDetails,
    ...liveMetricDetails,
    ...getSystemMemoryAtGoneDetails()
  }
  // Why: with the crasher gone, Largest names a survivor — flag that so the
  // live buckets are read as "everyone else", not as the crashed process.
  // Same-bucket survivors are the norm (webview guests, the dashboard popout,
  // origin-bar views), so a zero bucket count alone under-detects: also treat
  // a sampled same-bucket pid that vanished from the live set as proof. That
  // still misses a crasher younger than the last sweep, and Vanished can
  // include a legitimately-closed same-bucket process — Pid is only emitted
  // when the vanished process is unambiguous.
  const crashedBucket = metricTypeBucket(crashedProcessType)
  const crashedBucketCountKey = `${PROCESS_METRICS_KEY_PREFIX}${titleCaseBucket(crashedBucket)}Count`
  const vanished =
    livePids && preGoneSample
      ? preGoneSample.processes.filter((p) => p.bucket === crashedBucket && !livePids.has(p.pid))
      : []
  if (liveMetricDetails[crashedBucketCountKey] === 0 || vanished.length > 0) {
    crashDetails.processMetricsCrashedProcessAbsent = true
  }
  if (vanished.length > 0) {
    crashDetails.processMetricsVanishedCount = vanished.length
    crashDetails.processMetricsVanishedWorkingSetMB = vanished.reduce(
      (sum, p) => sum + p.workingSetMB,
      0
    )
    if (vanished.length === 1) {
      crashDetails.processMetricsVanishedPid = vanished[0].pid
    }
  }
  if (preGoneSample) {
    Object.assign(crashDetails, preGoneSampleDetails(preGoneSample, Date.now()))
  }
  return crashDetails
}

export function buildSuppressedProcessGoneBreadcrumbData({
  source,
  processType,
  reason,
  exitCode,
  expectedTeardown,
  details
}: {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}): CrashReportBreadcrumbData {
  const breadcrumb: CrashReportBreadcrumbData = {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown
  }
  const name = safeString(details.name)
  if (name) {
    breadcrumb.name = name
  }
  const serviceName = safeString(details.serviceName)
  if (serviceName) {
    breadcrumb.serviceName = serviceName
  }
  const type = safeString(details.type)
  if (type) {
    breadcrumb.type = type
  }
  return breadcrumb
}
