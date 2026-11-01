import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import {
  registerManagedServerActions,
  registerManagedServerMaintenanceActions,
  type ManagedServerActions,
  type ManagedServerMaintenanceActions
} from '../managed-server-actions-registry'
import {
  MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../../shared/host-runtime-capabilities'

describe('managed server capability', () => {
  afterEach(() => registerManagedServerActions(null))

  // A runtime without the desktop's SSH registry must not point clients at methods that refuse.
  it('is advertised only where the desktop registered the managed-server actions', () => {
    registerManagedServerActions(null)
    const none = createRuntime().getStatus().capabilities
    expect(none).not.toContain(MANAGED_SERVER_RUNTIME_CAPABILITY)
    expect(none).not.toContain(MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getStatus only checks that actions are registered.
    registerManagedServerActions({} as ManagedServerActions)
    const full = createRuntime().getStatus().capabilities
    expect(full).toContain(MANAGED_SERVER_RUNTIME_CAPABILITY)
    // The full suite implies the maintenance subset.
    expect(full).toContain(MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY)
  })

  // B1: a headless serve registers status and update only; the full capability would have the
  // CLI offer stop/forget/rollback/recover against a host that cannot run them.
  it('advertises only the maintenance subset for a headless registration', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getStatus only checks that actions are registered.
    registerManagedServerMaintenanceActions({} as ManagedServerMaintenanceActions)
    const capabilities = createRuntime().getStatus().capabilities
    expect(capabilities).toContain(MANAGED_SERVER_MAINTENANCE_RUNTIME_CAPABILITY)
    expect(capabilities).not.toContain(MANAGED_SERVER_RUNTIME_CAPABILITY)
  })
})
