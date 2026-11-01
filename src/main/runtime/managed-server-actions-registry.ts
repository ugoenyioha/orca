/**
 * The managed-server actions the Managed servers settings run, published by the desktop main
 * process so runtime RPC can offer the same ones. A headless `orca serve` registers only the
 * maintenance subset (status, update) after its SSH layer loads; it never advertises the full
 * suite, so stop/forget/rollback/recover/cancelStop refuse there with a stable code instead of
 * a stub that happens to throw.
 */
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedForgetResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import {
  MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../shared/host-runtime-capabilities'

export type ManagedServerActions = {
  status: (selector: string) => Promise<OrcadManagedRuntimeStatus>
  update: (selector: string, force: boolean) => Promise<OrcadManagedDeployResult>
  rollback: (selector: string) => Promise<OrcadManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<OrcadManagedRecoveryResult>
  stop: (selector: string) => Promise<OrcadManagedStopResult>
  cancelStop: (selector: string) => Promise<OrcadManagedCancelStopResult>
  /** Unlinks a server whose host cannot answer, without stopping it there. */
  forget: (selector: string) => Promise<OrcadManagedForgetResult>
}

/** What a headless serve can do to the servers it deployed: read, and roll forward. */
export type ManagedServerMaintenanceActions = Pick<ManagedServerActions, 'status' | 'update'>

export type ManagedServerRegistration =
  | { kind: 'full'; actions: ManagedServerActions }
  | { kind: 'maintenance'; actions: ManagedServerMaintenanceActions }

let registered: ManagedServerRegistration | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions ? { kind: 'full', actions } : null
}

/** Headless serve: the SSH layer loaded but no window ever will; only status and update apply. */
export function registerManagedServerMaintenanceActions(
  actions: ManagedServerMaintenanceActions | null
): void {
  registered = actions ? { kind: 'maintenance', actions } : null
}

export function getManagedServerRegistration(): ManagedServerRegistration | null {
  return registered
}

/** The full suite, or null where only the maintenance subset (or nothing) is registered. */
export function getManagedServerActions(): ManagedServerActions | null {
  return registered?.kind === 'full' ? registered.actions : null
}

/** Full suite implies the maintenance subset, never the reverse: headless registers status+update only. */
export function managedServerCapabilities(): string[] {
  if (!registered) {
    return []
  }
  return registered.kind === 'full'
    ? [MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY, MANAGED_SERVER_RUNTIME_CAPABILITY]
    : [MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY]
}
