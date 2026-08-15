import { app } from 'electron'
import {
  sanitizeCrashReportDetails,
  type CrashReportDetailValue
} from '../../shared/crash-reporting'
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
  // Bucket per pid, not a bare pid set: a recycled pid living on as a
  // different process type must still read as a vanished sampled process.
  pidBuckets: Map<number, ProcessMetricBucketName> | null
}

function getLiveProcessGoneMetrics(): LiveProcessGoneMetrics {
  try {
    const metrics = app.getAppMetrics()
    const pidBuckets = new Map<number, ProcessMetricBucketName>()
    for (const metric of metrics) {
      const pid = safeFiniteNumber(metric.pid)
      if (pid !== undefined) {
        pidBuckets.set(pid, metricTypeBucket(metric.type))
      }
    }
    return { details: collectProcessGoneMetricDetails(metrics), pidBuckets }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error
    return { details: { processMetricsError: errorName }, pidBuckets: null }
  }
}

// ─── Pre-gone metric sampling ───────────────────────────────────────
// Why: process-gone fires after the crashed process left Chromium's registry,
// so gone-time getAppMetrics() only sees survivors — field reports carried
// processMetricsRendererCount=0 for every renderer death. A periodic sample
// keeps the last pre-death working sets so the crasher's size survives it.
// Staleness honesty: PreGone values are sample-time, not death-time — a
// process that grew in the up-to-60s before death is understated, bounded
// only by PreGoneSampleAgeMs and the lifetime peak fields.

export const PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS = 60_000

type PreGoneSampledProcess = {
  pid: number
  bucket: ProcessMetricBucketName
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
    processes.push({ pid, bucket: metricTypeBucket(metric.type) })
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
  const { details: liveMetricDetails, pidBuckets: livePidBuckets } = getLiveProcessGoneMetrics()
  const crashDetails: CrashReportDetails = {
    ...sanitizedDetails,
    ...liveMetricDetails,
    ...getSystemMemoryAtGoneDetails()
  }
  // Why: with the crasher gone, Largest names a survivor — flag that so the
  // live buckets are read as "everyone else", not as the crashed process.
  // Same-bucket survivors are the norm (webview guests, the dashboard popout,
  // origin-bar views), so a zero bucket count alone under-detects: a sampled
  // same-bucket pid missing from the live set — including one the OS recycled
  // into a different bucket — also proves absence. The proof is stateless and
  // holds for every record of a crash loop. False negatives remain when the
  // crasher was younger than the last sweep, or when its pid was recycled
  // into a NEW same-bucket process inside the sweep window; a legitimately
  // closed sampled process can still trip the flag if the crasher's own row
  // somehow survives in the live enumeration.
  const crashedBucket = metricTypeBucket(crashedProcessType)
  const crashedBucketCountKey = `${PROCESS_METRICS_KEY_PREFIX}${titleCaseBucket(crashedBucket)}Count`
  const sampledSameBucketPidVanished = Boolean(
    livePidBuckets &&
    preGoneSample?.processes.some(
      (p) => p.bucket === crashedBucket && livePidBuckets.get(p.pid) !== p.bucket
    )
  )
  if (liveMetricDetails[crashedBucketCountKey] === 0 || sampledSameBucketPidVanished) {
    crashDetails.processMetricsCrashedProcessAbsent = true
  }
  if (preGoneSample) {
    Object.assign(crashDetails, preGoneSampleDetails(preGoneSample, Date.now()))
  }
  return crashDetails
}
