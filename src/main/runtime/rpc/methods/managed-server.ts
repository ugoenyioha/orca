import { MANAGED_SERVER_ACTION_UNAVAILABLE_CODE } from '../../../../shared/host-runtime-capabilities'
import {
  ManagedServerRecover,
  ManagedServerSelector,
  ManagedServerUpdate
} from '../../../../shared/rpc-contract/managed-server-params'
import {
  getManagedServerRegistration,
  type ManagedServerActions,
  type ManagedServerRegistration
} from '../../managed-server-actions-registry'
import { defineMethod } from '../core'

// Why a refusal and not a crash: only the desktop main process registers these actions, and a
// client must read their absence the same way it reads an older host's method_not_found.
function registration(): ManagedServerRegistration {
  const registered = getManagedServerRegistration()
  if (!registered) {
    throw new Error('managed_server_unavailable')
  }
  return registered
}

/** Thrown as a structured passthrough so a client can tell "not here" from an action failure. */
export class ManagedServerActionUnavailableError extends Error {
  readonly code = MANAGED_SERVER_ACTION_UNAVAILABLE_CODE
  readonly data: { action: string; registration: ManagedServerRegistration['kind'] }
  constructor(action: string, kind: ManagedServerRegistration['kind']) {
    super(
      `This Orca runtime registered no '${action}' managed-server action; run it from the desktop that deployed the server.`
    )
    this.name = 'ManagedServerActionUnavailableError'
    this.data = { action, registration: kind }
  }
}

// Why per method and not per suite: a headless serve registers only status and update, and
// each excluded action must refuse by name, not through a stub that happens to throw.
function fullActions(action: keyof ManagedServerActions): ManagedServerActions {
  const registered = registration()
  if (registered.kind !== 'full') {
    throw new ManagedServerActionUnavailableError(action, registered.kind)
  }
  return registered.actions
}

export const MANAGED_SERVER_METHODS = [
  defineMethod({
    name: 'managedServer.status',
    permission: 'workspace',
    params: ManagedServerSelector,
    handler: ({ selector }) => registration().actions.status(selector)
  }),
  defineMethod({
    name: 'managedServer.update',
    permission: 'host-admin',
    params: ManagedServerUpdate,
    handler: ({ selector, force }) => {
      const registered = registration()
      // Why refused here and not by the CLI: every paired runtime client holds host-admin, and
      // force lifts the host-newer downgrade refusal and restarts over live terminals; the
      // headless maintenance subset is roll-forward only, so force stays desktop-only.
      if (force === true && registered.kind !== 'full') {
        throw new ManagedServerActionUnavailableError('update --force', registered.kind)
      }
      return registered.actions.update(selector, force === true)
    }
  }),
  defineMethod({
    name: 'managedServer.rollback',
    permission: 'host-admin',
    params: ManagedServerSelector,
    handler: ({ selector }) => fullActions('rollback').rollback(selector)
  }),
  defineMethod({
    name: 'managedServer.recover',
    permission: 'host-admin',
    params: ManagedServerRecover,
    handler: ({ selector, acceptChangedState }) =>
      fullActions('recover').recover(selector, acceptChangedState === true)
  }),
  defineMethod({
    name: 'managedServer.stop',
    permission: 'host-admin',
    params: ManagedServerSelector,
    handler: ({ selector }) => fullActions('stop').stop(selector)
  }),
  defineMethod({
    name: 'managedServer.cancelStop',
    permission: 'host-admin',
    params: ManagedServerSelector,
    handler: ({ selector }) => fullActions('cancelStop').cancelStop(selector)
  }),
  // A new method, not a stop flag: an older desktop would drop the flag and decommission instead.
  defineMethod({
    name: 'managedServer.forget',
    permission: 'host-admin',
    params: ManagedServerSelector,
    handler: ({ selector }) => fullActions('forget').forget(selector)
  })
] as const
