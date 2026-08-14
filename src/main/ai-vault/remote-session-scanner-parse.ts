import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordSessionScanIssue } from './session-scan-issues'
import { sessionSortTime } from './session-scanner-accumulator'
import type { RemoteScannerContext, RemoteSessionCandidate } from './remote-session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function parseRemoteSessionCandidate(
  candidate: RemoteSessionCandidate,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<AiVaultSession | null> {
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const read = await context.provider.readFile(candidate.file.path)
    throwIfAiVaultScanCancelled(context.signal)
    if (read.isBinary) {
      return null
    }
    const session = await candidate.source.parse(candidate.file, read.content, context)
    throwIfAiVaultScanCancelled(context.signal)
    // Mirror the local rule: every session carries its sibling subagent
    // transcript count (row badge; recoverable signal at zero turns). The
    // walk listing supplies it — the parser can't readdir a remote disk.
    const subagentTranscriptCount = candidate.subagentTranscriptCount ?? 0
    if (session && subagentTranscriptCount > 0) {
      return { ...session, subagentTranscriptCount }
    }
    return session
  } catch (err) {
    throwIfAiVaultScanCancelled(context.signal)
    recordSessionScanIssue(issues, {
      executionHostId: context.executionHostId,
      agent: candidate.source.agent,
      path: candidate.file.path,
      message: errorMessage(err)
    })
    return null
  }
}

export function mergeRemoteSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}

export function isRemoteSessionInScope(
  session: AiVaultSession,
  scopePaths: readonly string[]
): boolean {
  const cwd = session.cwd
  return Boolean(cwd && scopePaths.some((scopePath) => isPathInsideOrEqual(scopePath, cwd)))
}

export function normalizeRemoteScopePaths(scopePaths: readonly string[]): string[] {
  return scopePaths.map((scopePath) => scopePath.trim()).filter(Boolean)
}

export function canStopParsingRemoteSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtimes bound the remaining candidate order; once the visible
  // cutoff is newer, older files cannot enter the unscoped top-N result.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}

export function isAiVaultSession(session: AiVaultSession | null): session is AiVaultSession {
  return Boolean(session)
}
