import { app } from 'electron'
import {
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData,
  type CrashReportDetailValue
} from '../../shared/crash-reporting'
import type { ExpectedTeardownScope } from './process-gone-classification'

type ProcessMetricLike = {
  pid?: unknown
  type?: unknown
  memory?: {
    workingSetSize?: unknown
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

  for (const metric of metrics) {
    const bucket = buckets[metricTypeBucket(metric.type)]
    const metricWorkingSetMB = workingSetMB(metric)
    bucket.count += 1
    bucket.workingSetMB += metricWorkingSetMB
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
  if (largest) {
    details.processMetricsLargestPid = largest.pid
    details.processMetricsLargestType = largest.type
    details.processMetricsLargestWorkingSetMB = largest.workingSetMB
  }
  return details
}

function getProcessGoneMetricDetails(): CrashReportDetails {
  try {
    return collectProcessGoneMetricDetails(app.getAppMetrics())
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error
    return { processMetricsError: errorName }
  }
}

// ─── Pre-gone metric sampling ───────────────────────────────────────
// Why: process-gone fires after the crashed process left Chromium's registry,
// so gone-time getAppMetrics() only sees survivors — field reports carried
// processMetricsRendererCount=0 for every renderer death. A periodic sample
// keeps the last pre-death working sets so the crasher's size survives it.

export const PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS = 60_000

type PreGoneProcessMetricsSample = {
  details: CrashReportDetails
  sampledAtMs: number
}

let preGoneSample: PreGoneProcessMetricsSample | null = null
let preGoneSampleTimer: ReturnType<typeof setInterval> | null = null

export function samplePreGoneProcessMetrics(nowMs: number = Date.now()): void {
  try {
    preGoneSample = {
      details: collectProcessGoneMetricDetails(app.getAppMetrics()),
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
  const liveMetricDetails = getProcessGoneMetricDetails()
  const crashDetails: CrashReportDetails = {
    ...sanitizedDetails,
    ...liveMetricDetails
  }
  // Why: with the crasher gone, Largest names a survivor — flag that so the
  // live buckets are read as "everyone else", not as the crashed process.
  const crashedBucketCountKey = `${PROCESS_METRICS_KEY_PREFIX}${titleCaseBucket(metricTypeBucket(crashedProcessType))}Count`
  if (liveMetricDetails[crashedBucketCountKey] === 0) {
    crashDetails.processMetricsCrashedProcessAbsent = true
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
