import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError, readFileViaStream } from '../ssh/ssh-filesystem-stream-reader'
import { uploadBuffer } from '../ssh/sftp-upload'
import { lstatViaSftp } from './ssh-filesystem-provider-sftp'
import {
  downloadFileViaSftp,
  downloadFolderViaSftp,
  type SftpFactory
} from './ssh-filesystem-download'
import { openSshFileUploadSession, type SshRawTransferOptions } from './ssh-filesystem-file-upload'
import {
  stopSshFilesystemWatchRegistration,
  type WatchRegistration
} from './ssh-filesystem-provider-watch'
import type {
  IFilesystemProvider,
  FileReadLimits,
  FileStat,
  FileReadResult,
  FileUploadSession,
  TerminalArtifactAccessOptions
} from './types'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type { DirEntry, FsChangeEvent } from '../../shared/filesystem-entry-types'
import { routeSshFilesystemWatchNotification } from './ssh-filesystem-watch-notifications'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'
import type {
  CursorSidecarScanRequest,
  CursorSidecarScanResponse
} from '../../shared/cursor-sidecar-scan'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  closeSshFilesystemWatchOnMux,
  listSshFiles,
  scanSshCursorSidecarsOnMux,
  scanSshWorkspaceSpace,
  searchSshFiles,
  watchSshFilesystem
} from './ssh-filesystem-provider-listing'

export class SshFilesystemProvider implements IFilesystemProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer
  private watchListeners = new Map<string, WatchRegistration>()
  private unsubscribeNotifications: (() => void) | null = null
  private tempDirPromise: Promise<string> | null = null
  private disposed = false
  private loggedStreamFallback = false
  readonly downloadFolder?: IFilesystemProvider['downloadFolder']

  constructor(
    connectionId: string,
    mux: SshChannelMultiplexer,
    private readonly createSftp?: SftpFactory,
    private readonly rawTransfer?: SshRawTransferOptions,
    hostPlatform?: RemoteHostPlatform
  ) {
    this.connectionId = connectionId
    this.mux = mux

    if (createSftp) {
      // Why: system SSH has raw single-file transfer but no ssh2 SFTP channel;
      // omitting this method makes folder capability truthful at the provider boundary.
      // windowsRemotePaths is provider-owned (from host platform), not a caller option.
      const windowsRemotePaths = hostPlatform ? isWindowsRemoteHost(hostPlatform) : undefined
      this.downloadFolder = (sourcePath, destinationPath, options) =>
        downloadFolderViaSftp(createSftp, sourcePath, destinationPath, {
          ...options,
          windowsRemotePaths
        })
    }

    this.unsubscribeNotifications = mux.onNotification((method, params) =>
      routeSshFilesystemWatchNotification(this.watchListeners, method, params)
    )
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications()
      this.unsubscribeNotifications = null
    }
    for (const registration of this.watchListeners.values()) {
      stopSshFilesystemWatchRegistration(this.mux, registration)
    }
    this.watchListeners.clear()
  }

  getConnectionId(): string {
    return this.connectionId
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    return (await this.mux.request('fs.readDir', { dirPath })) as DirEntry[]
  }

  async readFile(filePath: string, limits?: FileReadLimits): Promise<FileReadResult> {
    // Why: streaming is the default path so previews above the legacy single-
    // frame budget (~12 MB after base64) don't hit MAX_MESSAGE_SIZE. Old relays
    // that don't implement fs.readFileStream surface as MethodNotFound; we fall
    // back to the legacy single-shot fs.readFile (which retains the old 10 MB
    // cap on those hosts).
    try {
      return await readFileViaStream(this.mux, filePath, limits)
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        if (!this.loggedStreamFallback) {
          this.loggedStreamFallback = true
          console.warn(
            '[ssh-fs] Relay does not implement fs.readFileStream; falling back to fs.readFile (10 MB cap)'
          )
        }
        return (await this.mux.request('fs.readFile', { filePath })) as FileReadResult
      }
      throw err
    }
  }

  async readTerminalArtifact(
    filePath: string,
    options: TerminalArtifactAccessOptions
  ): Promise<FileReadResult> {
    try {
      return (await this.mux.request('fs.readTerminalArtifact', {
        filePath,
        expectedRealPath: options.expectedRealPath,
        expectedStatIdentity: options.expectedStatIdentity,
        maxBytes: options.maxBytes
      })) as FileReadResult
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        throw new Error(
          'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
        )
      }
      throw err
    }
  }

  async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
    // Why: system SSH targets cannot open an ssh2-owned SFTP channel.
    if (this.rawTransfer?.downloadFile) {
      await this.rawTransfer.downloadFile(sourcePath, destinationPath)
      return
    }
    await downloadFileViaSftp(this.createSftp, sourcePath, destinationPath)
  }

  async openFileUploadSession(): Promise<FileUploadSession> {
    return openSshFileUploadSession(this.createSftp, this.rawTransfer)
  }

  async getTempDir(): Promise<string> {
    this.tempDirPromise ??= this.mux.request('fs.tempDir', {}).then(
      (result) => result as string,
      (err) => {
        this.tempDirPromise = null
        if (isMethodNotFoundError(err)) {
          return '/tmp'
        }
        throw err
      }
    )
    return this.tempDirPromise
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.mux.request('fs.writeFile', { filePath, content })
  }

  async writeTerminalArtifact(
    filePath: string,
    content: string,
    options: TerminalArtifactAccessOptions
  ): Promise<FileStat> {
    let result: { stat?: FileStat }
    try {
      result = (await this.mux.request('fs.writeTerminalArtifact', {
        filePath,
        content,
        expectedRealPath: options.expectedRealPath,
        expectedStatIdentity: options.expectedStatIdentity,
        maxBytes: options.maxBytes
      })) as { stat?: FileStat }
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        throw new Error(
          'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
        )
      }
      throw err
    }
    if (!result.stat) {
      throw new Error('terminal_file_grant_stale')
    }
    return result.stat
  }

  async writeFileBase64(filePath: string, contentBase64: string): Promise<void> {
    await this.writeFileBase64Chunk(filePath, contentBase64, false)
  }

  async writeFileBase64Chunk(
    filePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<void> {
    const contents = Buffer.from(contentBase64, 'base64')
    if (this.rawTransfer?.writeBuffer) {
      await this.rawTransfer.writeBuffer(filePath, contents, { append, exclusive: !append })
      return
    }
    if (!this.createSftp) {
      throw new Error('remote_binary_upload_unavailable')
    }
    const sftp = await this.createSftp()
    try {
      // Why: relay fs.writeFile is text-only. SFTP writes the decoded bytes
      // directly so runtime uploads do not corrupt images, PDFs, or archives.
      await uploadBuffer(sftp, contents, filePath, {
        append,
        exclusive: !append
      })
    } finally {
      sftp.end()
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    return (await this.mux.request('fs.stat', { filePath })) as FileStat
  }

  async lstat(filePath: string): Promise<FileStat> {
    try {
      return (await this.mux.request('fs.lstat', { filePath })) as FileStat
    } catch (err) {
      if (!isMethodNotFoundError(err)) {
        throw err
      }
      if (!this.createSftp) {
        throw new Error('remote_lstat_unavailable')
      }
      const sftp = await this.createSftp()
      try {
        // Why: older relays predate fs.lstat, but SFTP can still preserve
        // symlink identity for orphaned-worktree safety checks.
        return await lstatViaSftp(sftp, filePath)
      } finally {
        sftp.end()
      }
    }
  }

  scanCursorSidecars = (
    request: CursorSidecarScanRequest,
    options?: { signal?: AbortSignal }
  ): Promise<CursorSidecarScanResponse> => scanSshCursorSidecarsOnMux(this.mux, request, options)

  scanWorkspaceSpace = (
    rootPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceSpaceDirectoryScanResult> =>
    scanSshWorkspaceSpace(this.mux, rootPath, options)

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    await this.mux.request('fs.deletePath', { targetPath, recursive })
  }

  async createFile(filePath: string): Promise<void> {
    await this.mux.request('fs.createFile', { filePath })
  }

  async createDir(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDir', { dirPath })
  }

  async createDirNoClobber(dirPath: string): Promise<void> {
    await this.mux.request('fs.createDirNoClobber', { dirPath })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.mux.request('fs.rename', { oldPath, newPath })
  }

  async renameNoClobber(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.mux.request('fs.renameNoClobber', { oldPath, newPath })
    } catch (err) {
      if (isMethodNotFoundError(err)) {
        // Why: falling back to raw fs.rename can silently clobber the target on
        // older relays. Fail closed and let reconnect deploy the safe relay.
        throw new Error('Remote safe rename is unavailable. Reconnect the SSH target and retry.')
      }
      throw err
    }
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.mux.request('fs.copy', { source, destination })
  }

  async realpath(filePath: string): Promise<string> {
    return (await this.mux.request('fs.realpath', { filePath })) as string
  }

  search = (opts: SearchOptions): Promise<SearchResult> => searchSshFiles(this.mux, opts)

  listFiles = (
    rootPath: string,
    options?: { excludePaths?: string[]; signal?: AbortSignal; maxResults?: number }
  ): Promise<string[]> => listSshFiles(this.mux, rootPath, options)

  watch = (
    rootPath: string,
    callback: (events: FsChangeEvent[]) => void,
    options?: { signal?: AbortSignal; onTerminalError?: (error: Error) => void }
  ): Promise<() => void> =>
    watchSshFilesystem({
      mux: this.mux,
      disposed: () => this.disposed,
      registrations: this.watchListeners,
      rootPath,
      callback,
      options
    })

  closeWatch = (rootPath: string): Promise<void> =>
    closeSshFilesystemWatchOnMux(this.mux, this.watchListeners, rootPath)
}
