export type ProcessGoneSource = 'renderer' | 'child'
export type ExpectedTeardownScope = 'none' | 'renderer-reload' | 'app-shutdown'

const WINDOWS_CONTROL_TERMINATION_EXIT_CODES = new Set([0xc000013a, 0x40010004])
const RECOVERABLE_CHILD_PROCESS_TYPES = new Set(['gpu'])
const RECOVERABLE_UTILITY_SERVICE_NAMES = new Set([
  'audio.mojom.AudioService',
  'network.mojom.NetworkService',
  // Why: Windows media/screen capture can churn this Chromium utility without
  // taking down Orca; prompting users for those child exits is noise.
  'video_capture.mojom.VideoCaptureService'
])
const RECOVERABLE_CHILD_PROCESS_REASONS = new Set(['abnormal-exit', 'crashed', 'killed'])
const NON_RECOVERABLE_RENDERER_REASONS = new Set(['integrity-failure'])

function isWindowsControlTerminationExitCode(exitCode: number | null): boolean {
  if (exitCode === null) {
    return false
  }
  return WINDOWS_CONTROL_TERMINATION_EXIT_CODES.has(exitCode >>> 0)
}

function isRecoverableChromiumChildProcess({
  source,
  processType,
  serviceName,
  reason
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
}): boolean {
  if (source !== 'child') {
    return false
  }
  if (!RECOVERABLE_CHILD_PROCESS_REASONS.has(reason)) {
    return false
  }
  const normalizedProcessType = processType?.toLowerCase()
  if (normalizedProcessType && RECOVERABLE_CHILD_PROCESS_TYPES.has(normalizedProcessType)) {
    return true
  }
  return (
    normalizedProcessType === 'utility' &&
    serviceName !== undefined &&
    RECOVERABLE_UTILITY_SERVICE_NAMES.has(serviceName)
  )
}

export function shouldRecordProcessGoneCrash({
  source,
  processType,
  serviceName,
  reason,
  exitCode,
  expectedTeardown,
  siblingChildKills = 0
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  siblingChildKills?: number
}): boolean {
  // Why: GPU, Network Service, and Audio Service exits are recoverable Chromium
  // child-process churn; treating them as app crashes creates noisy user prompts.
  if (isRecoverableChromiumChildProcess({ source, processType, serviceName, reason })) {
    return false
  }
  // Why: Electron reports intentional reload/update/quit teardown as `killed`.
  // Real renderer OOMs and Chromium crashes should still reach crash reporting.
  if (reason !== 'killed') {
    return true
  }
  // Why: when the OS or user kills the whole process tree, the Chromium
  // children die the same way milliseconds from the renderer. That is
  // teardown, not a renderer crash, and the exit code alone cannot tell the
  // two apart. Complements the session-end window, which end-task and
  // Restart Manager kills never trigger.
  if (source === 'renderer' && siblingChildKills > 0) {
    return false
  }
  // Why: Electron reports expected Chromium teardown during reload/update as
  // `killed` + SIGTERM or Windows control termination statuses. Treat real
  // crash reasons as reportable, but skip these normal termination shapes.
  if (exitCode === 15 || isWindowsControlTerminationExitCode(exitCode)) {
    return false
  }
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(source === 'renderer' && expectedTeardown === 'renderer-reload')
}

// Why: deliberately ignores sibling tree kills. Suppressing a *report* on that
// signature costs one lost report; suppressing the *reload* strands the user in
// a blank window with no prompt (scheduleRendererRecovery bails synchronously,
// so the exhausted-recovery prompt never fires either). Field bundles show the
// renderer reloading and the same main process living on for minutes after a
// child kill, so the reload is the only thing that recovers those users. If the
// tree really is dying, the main process is gone before the reload lands.
export function shouldRecoverRendererAfterProcessGone({
  reason,
  expectedTeardown
}: {
  reason: string
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  // Why: an integrity failure means Chromium cannot trust the renderer, so a
  // reload cannot safely recover it. Launch failures can be transient and are
  // bounded by the caller's renderer-recovery circuit breaker.
  if (NON_RECOVERABLE_RENDERER_REASONS.has(reason)) {
    return false
  }
  return !(reason === 'killed' && expectedTeardown === 'renderer-reload')
}
