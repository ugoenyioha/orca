import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  registerManagedServerActions,
  registerManagedServerMaintenanceActions,
  type ManagedServerActions
} from '../../managed-server-actions-registry'
import { MANAGED_SERVER_ACTION_UNAVAILABLE_CODE } from '../../../../shared/host-runtime-capabilities'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { MANAGED_SERVER_METHODS } from './managed-server'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'managed-1', authToken: 'token', method, params }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read no runtime member; only the reply envelope needs getRuntimeId.
const RUNTIME = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService

function dispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime: RUNTIME, methods: MANAGED_SERVER_METHODS })
}

function actions(): ManagedServerActions {
  return {
    status: vi.fn(),
    update: vi.fn(async () => ({
      outcome: 'deferred' as const,
      candidateVersion: '2',
      code: 'c',
      reason: 'r'
    })),
    rollback: vi.fn(),
    recover: vi.fn(async () => ({ outcome: 'none' as const })),
    stop: vi.fn(async () => ({
      outcome: 'refused' as const,
      verdict: 'live' as const,
      code: 'c',
      reason: 'r'
    })),
    cancelStop: vi.fn(),
    forget: vi.fn(async () => ({
      outcome: 'forgotten' as const,
      verdict: 'unverifiable' as const,
      environmentId: 'env-1',
      sshTargetId: 'ssh-1'
    }))
  }
}

afterEach(() => registerManagedServerActions(null))

describe('managed server RPC', () => {
  it('refuses where no desktop runtime registered the actions', async () => {
    const response = await dispatcher().dispatch(
      request('managedServer.stop', { selector: 'build-box' })
    )
    expect(response).toMatchObject({ ok: false })
  })

  it('forwards to the same actions the settings run', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    await expect(
      dispatcher().dispatch(request('managedServer.stop', { selector: 'build-box' }))
    ).resolves.toMatchObject({ ok: true, result: { outcome: 'refused' } })
    expect(registered.stop).toHaveBeenCalledWith('build-box')

    await dispatcher().dispatch(request('managedServer.update', { selector: 'build-box' }))
    expect(registered.update).toHaveBeenCalledWith('build-box', false)
    await dispatcher().dispatch(
      request('managedServer.update', { selector: 'build-box', force: true })
    )
    expect(registered.update).toHaveBeenLastCalledWith('build-box', true)

    await dispatcher().dispatch(request('managedServer.forget', { selector: 'build-box' }))
    expect(registered.forget).toHaveBeenCalledWith('build-box')
    expect(registered.stop).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing selector before reaching an action', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    const response = await dispatcher().dispatch(request('managedServer.recover', {}))
    expect(response).toMatchObject({ ok: false })
    expect(registered.recover).not.toHaveBeenCalled()
  })

  it('passes the confirmed changed-state restore through to recover', async () => {
    const registered = actions()
    registerManagedServerActions(registered)
    await dispatcher().dispatch(
      request('managedServer.recover', { selector: 'build-box', acceptChangedState: true })
    )
    expect(registered.recover).toHaveBeenLastCalledWith('build-box', true)
    await dispatcher().dispatch(request('managedServer.recover', { selector: 'build-box' }))
    expect(registered.recover).toHaveBeenLastCalledWith('build-box', false)
  })
})

// B1/B2: a headless serve registers only status and update. Every other method, and update
// with force, must refuse on the wire with a stable code and never reach a lifecycle action.
describe('managed server RPC on a maintenance-only (headless) registration', () => {
  function maintenance() {
    const registered = actions()
    registerManagedServerMaintenanceActions({
      status: registered.status,
      update: registered.update
    })
    return registered
  }

  it('serves status and a plain update through the dispatcher', async () => {
    const registered = maintenance()
    await expect(
      dispatcher().dispatch(request('managedServer.update', { selector: 'build-box' }))
    ).resolves.toMatchObject({ ok: true, result: { outcome: 'deferred' } })
    expect(registered.update).toHaveBeenCalledWith('build-box', false)
    await dispatcher().dispatch(request('managedServer.status', { selector: 'build-box' }))
    expect(registered.status).toHaveBeenCalledWith('build-box')
  })

  it('refuses update --force on the wire without calling update', async () => {
    const registered = maintenance()
    await expect(
      dispatcher().dispatch(
        request('managedServer.update', { selector: 'build-box', force: true })
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: MANAGED_SERVER_ACTION_UNAVAILABLE_CODE,
        data: { action: 'update --force', registration: 'maintenance' }
      }
    })
    expect(registered.update).not.toHaveBeenCalled()
  })

  it.each([
    ['managedServer.rollback', 'rollback', { selector: 'build-box' }],
    ['managedServer.recover', 'recover', { selector: 'build-box', acceptChangedState: true }],
    ['managedServer.stop', 'stop', { selector: 'build-box' }],
    ['managedServer.cancelStop', 'cancelStop', { selector: 'build-box' }],
    ['managedServer.forget', 'forget', { selector: 'build-box' }]
  ] as const)('refuses %s with managed_server_action_unavailable', async (method, action, params) => {
    const registered = maintenance()
    await expect(dispatcher().dispatch(request(method, params))).resolves.toMatchObject({
      ok: false,
      error: {
        code: MANAGED_SERVER_ACTION_UNAVAILABLE_CODE,
        data: { action, registration: 'maintenance' }
      }
    })
    for (const lifecycle of [
      registered.rollback,
      registered.recover,
      registered.stop,
      registered.cancelStop,
      registered.forget
    ]) {
      expect(lifecycle).not.toHaveBeenCalled()
    }
  })

  it('still rejects a missing selector before the per-action guard', async () => {
    maintenance()
    const response = await dispatcher().dispatch(request('managedServer.stop', {}))
    expect(response).toMatchObject({ ok: false })
    expect(response).not.toMatchObject({
      error: { code: MANAGED_SERVER_ACTION_UNAVAILABLE_CODE }
    })
  })
})
