import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type {
  CursorSidecarScanRequest,
  CursorSidecarScanResponse
} from '../../shared/cursor-sidecar-scan'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { scanSshCursorSidecars } from './ssh-cursor-sidecar-scan'
import {
  closeSshFilesystemWatch,
  registerSshFilesystemWatch,
  type WatchRegistration
} from './ssh-filesystem-provider-watch'

const WORKSPACE_SPACE_SCAN_TIMEOUT_MS = 130_000

export function scanSshCursorSidecarsOnMux(
  mux: SshChannelMultiplexer,
  request: CursorSidecarScanRequest,
  options?: { signal?: AbortSignal }
): Promise<CursorSidecarScanResponse> {
  return scanSshCursorSidecars(mux, request, options)
}

export async function scanSshWorkspaceSpace(
  mux: SshChannelMultiplexer,
  rootPath: string,
  options?: { signal?: AbortSignal }
): Promise<WorkspaceSpaceDirectoryScanResult> {
  return (await mux.request(
    'fs.workspaceSpaceScan',
    { rootPath },
    { signal: options?.signal, timeoutMs: WORKSPACE_SPACE_SCAN_TIMEOUT_MS }
  )) as WorkspaceSpaceDirectoryScanResult
}

export async function listSshFiles(
  mux: SshChannelMultiplexer,
  rootPath: string,
  options?: { excludePaths?: string[]; signal?: AbortSignal; maxResults?: number }
): Promise<string[]> {
  const params: Record<string, unknown> = { rootPath }
  if (options?.excludePaths && options.excludePaths.length > 0) {
    params.excludePaths = options.excludePaths
  }
  if (options?.maxResults !== undefined) {
    params.maxResults = options.maxResults
  }
  // Why #7721: the signal lets a workspace switch send rpc.cancel so the
  // relay aborts the full-tree scan instead of stacking abandoned scans
  // that starve interactive fs.readDir/fs.stat on the shared SSH channel.
  return (await mux.request('fs.listFiles', params, {
    signal: options?.signal
  })) as string[]
}

export function searchSshFiles(
  mux: SshChannelMultiplexer,
  opts: SearchOptions
): Promise<SearchResult> {
  return mux.request('fs.search', opts) as Promise<SearchResult>
}

export function watchSshFilesystem(args: {
  mux: SshChannelMultiplexer
  disposed: () => boolean
  registrations: Map<string, WatchRegistration>
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  options?: { signal?: AbortSignal; onTerminalError?: (error: Error) => void }
}): Promise<() => void> {
  return registerSshFilesystemWatch({
    mux: args.mux,
    disposed: args.disposed,
    registrations: args.registrations,
    rootPath: args.rootPath,
    callback: args.callback,
    onTerminalError: args.options?.onTerminalError,
    signal: args.options?.signal
  })
}

export function closeSshFilesystemWatchOnMux(
  mux: SshChannelMultiplexer,
  registrations: Map<string, WatchRegistration>,
  rootPath: string
): Promise<void> {
  return closeSshFilesystemWatch(mux, registrations, rootPath)
}
