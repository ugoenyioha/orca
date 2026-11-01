import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('../ipc/ssh/ssh-ipc-module-mocks')
  return createSshIpcMocks()
})
const headless = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return {
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-headless-serve-')),
    hasOrcadTemplate: vi.fn(() => true),
    createManagedOrcadActions: vi.fn()
  }
})

vi.mock('../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
// Why app.getPath: the real transport invalidator resolves the environment list by user data path.
vi.mock('electron', () => ({
  ...mocks.electron,
  app: { getPath: () => headless.userDataPath }
}))
vi.mock('../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ipc/ssh/ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
vi.mock('../orcad/orcad-artifact-materializer', () => ({
  hasOrcadTemplate: headless.hasOrcadTemplate
}))
// Why only the factory is mocked: the lifecycle actions need a real SSH host; the transport
// invalidator and pairing-repair wiring are the real desktop modules, exercised with no window.
vi.mock('../ipc/runtime-environments/managed-orcad-actions', () => ({
  createManagedOrcadActions: headless.createManagedOrcadActions
}))

import { resetSshHandlerStateForTests } from '../ipc/ssh/ssh'
import {
  connectRegisteredSshTarget,
  listRegisteredSshTargets,
  SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE
} from '../ssh/targets/ssh-target-registry'
import { createSshIpcHarness } from '../ipc/ssh/ssh-ipc-test-harness'
import type { SshTarget } from '../../shared/ssh-types'
import {
  getManagedServerActions,
  getManagedServerRegistration,
  registerManagedServerActions
} from '../runtime/managed-server-actions-registry'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { notifyManagedOrcadPairingRepaired } from '../managed-server/lifecycle/orcad-managed-pairing-repaired-listener'
import { setManagedOrcadPairingRepairedListener } from '../managed-server/lifecycle/orcad-managed-pairing-repaired-listener'
import { recoverRefusedPairing } from '../ipc/runtime-environments/runtime-environment-pairing-refusal-registry'
import { mainProcessState } from './main-process-state'
import { registerHeadlessServeSshHandlers } from './headless-serve-ssh-registration'

const { mockSshStore, mockConnectionManager } = mocks
const target: SshTarget = {
  id: 'ssh-1',
  label: 'build box',
  host: 'build.example',
  port: 22,
  username: 'deploy'
}

function fullActions() {
  return {
    status: vi.fn(),
    update: vi.fn(),
    rollback: vi.fn(),
    recover: vi.fn(),
    stop: vi.fn(),
    cancelStop: vi.fn(),
    forget: vi.fn()
  }
}

describe('SSH registration on a headless `orca serve`', () => {
  const harness = createSshIpcHarness(mocks)

  beforeEach(async () => {
    await harness.reset()
    // Why: a headless serve never attached a window, so nothing registered the SSH layer.
    await resetSshHandlerStateForTests()
    registerManagedServerActions(null)
    mainProcessState.mainWindow = null
    headless.hasOrcadTemplate.mockReset().mockReturnValue(true)
    headless.createManagedOrcadActions.mockReset().mockImplementation(fullActions)
    // Each test proves the wiring installs; start from the module default (no listener).
    setManagedOrcadPairingRepairedListener(() => {})
  })

  it('reproduces the unregistered host before bootstrap (#25886, #8489)', async () => {
    expect(listRegisteredSshTargets()).toEqual([])
    await expect(connectRegisteredSshTarget('ssh-1')).rejects.toThrow(
      SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE
    )
  })

  it('lists and connects persisted SSH targets with no window', async () => {
    mockSshStore.listTargets.mockReturnValue([target])
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH harness store implements every method registerSshHandlers reads.
    registerHeadlessServeSshHandlers(harness.mockStore as never, {} as never)

    expect(listRegisteredSshTargets()).toEqual([target])
    await expect(connectRegisteredSshTarget('ssh-1')).resolves.toMatchObject({
      targetId: 'ssh-1',
      status: 'connected'
    })
    expect(harness.mockWindow.webContents.send).not.toHaveBeenCalled()
  })

  // B1/B3/C2: only status and update are registered, the full suite is never exposed, the
  // desktop's transport invalidator and pairing-repair wiring are reused rather than re-implemented.
  it('registers the managed-server maintenance subset with the real desktop invalidator', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH harness store implements every method registerSshHandlers reads.
    registerHeadlessServeSshHandlers(harness.mockStore as never, {} as never)

    const registration = getManagedServerRegistration()
    expect(registration?.kind).toBe('maintenance')
    expect(Object.keys(registration?.actions ?? {}).sort()).toEqual(['status', 'update'])
    expect(getManagedServerActions()).toBeNull()
    const options = headless.createManagedOrcadActions.mock.calls[0]?.[0] as {
      invalidateTransport: typeof invalidateRuntimeEnvironmentTransport
    }
    expect(options.invalidateTransport).toBe(invalidateRuntimeEnvironmentTransport)
    // The real invalidator runs with no window and no environment of that id: nothing to publish to.
    await expect(options.invalidateTransport('env-missing')).resolves.toBeUndefined()
    expect(harness.mockWindow.webContents.send).not.toHaveBeenCalled()
  })

  // C2: a pairing the census repairs mid-update must retire the former peer's transports headless too.
  it('installs the desktop pairing-repair wiring before any window exists', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH harness store implements every method registerSshHandlers reads.
    registerHeadlessServeSshHandlers(harness.mockStore as never, {} as never)

    // Repaired-pairing listener is the real invalidator (resolves, publishes to no window);
    // the module default is a sync no-op that returns undefined, not a promise.
    const repaired = notifyManagedOrcadPairingRepaired('env-missing')
    expect(repaired).toBeInstanceOf(Promise)
    await expect(repaired).resolves.toBeUndefined()
    // Refused-pairing recovery consults the real environment store: unknown id => null, no throw.
    expect(recoverRefusedPairing('env-missing')).toBeNull()
    expect(harness.mockWindow.webContents.send).not.toHaveBeenCalled()
  })

  // B4: a build without the orcad template cannot update; the capability promises status AND
  // update, so neither is advertised. The pairing-repair wiring still installs (C6).
  it('registers no managed-server actions when this build carries no orcad template', async () => {
    headless.hasOrcadTemplate.mockReturnValue(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH harness store implements every method registerSshHandlers reads.
    registerHeadlessServeSshHandlers(harness.mockStore as never, {} as never)

    expect(getManagedServerRegistration()).toBeNull()
    expect(headless.createManagedOrcadActions).not.toHaveBeenCalled()
    expect(notifyManagedOrcadPairingRepaired('env-missing')).toBeInstanceOf(Promise)
  })
})
