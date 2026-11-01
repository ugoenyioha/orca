import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerSshHandlers } from '../ipc/ssh/ssh'
import { registerManagedServerMaintenanceActions } from '../runtime/managed-server-actions-registry'
import { createManagedOrcadActions } from '../ipc/runtime-environments/managed-orcad-actions'
import {
  installManagedOrcadPairingRepairWiring,
  invalidateRuntimeEnvironmentTransport
} from '../ipc/runtime-environments/runtime-environments'
import { clearManagedServerNotes } from '../ipc/runtime-environments/runtime-environment-managed-tunnel'
import { clearPublishedManagedServer } from '../ipc/ssh/ssh-renderer-broadcast'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { getAppEnvironment } from '../../shared/app-environment'
import { mainProcessState as state } from './main-process-state'

/**
 * Loads the profile's SSH targets on an `orca serve` host before any window exists.
 * Why: only window attach registered the SSH layer, so a headless serve listed no targets and
 * every connect threw ssh_handlers_not_registered (#25886, #8489). A later window attach
 * re-registers idempotently; until then broadcasts are skipped because there is no window.
 *
 * With the SSH layer loaded, the servers this profile deployed can be read and rolled forward
 * from here too (`orca environment status|update`). Only that maintenance subset is registered
 * and advertised; the full suite (stop, forget, rollback, recover, cancelStop) and `--force`
 * stay desktop-only, refused by name at the RPC method. A later window attach replaces this
 * registration with the full suite through registerOrcadRuntimeMaintenanceHandlers.
 */
export function registerHeadlessServeSshHandlers(store: Store, runtime: OrcaRuntimeService): void {
  registerSshHandlers(store, () => state.mainWindow ?? null, runtime)
  // Why before the template gate: the desktop installs this from registerRuntimeEnvironmentHandlers,
  // which never runs headless. A pairing the status census repairs must retire the former peer's
  // transports whether or not this build can also update.
  installManagedOrcadPairingRepairWiring()
  // Why gated on the template: without it update can only throw artifacts-unavailable, and the
  // maintenance capability promises status AND update, so neither is advertised. (Status alone
  // without the template is not offered; the capability contract is the pair.)
  if (!hasOrcadTemplate()) {
    return
  }
  const actions = createManagedOrcadActions({
    // Same resolution the SSH layer above uses (ssh.ts); the desktop's app.getPath is the same path.
    getUserDataPath: () => getAppEnvironment().getPath('userData'),
    getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
    // The same transport invalidator the desktop uses; its renderer publishes are null-window guarded.
    invalidateTransport: invalidateRuntimeEnvironmentTransport,
    clearHostServerStatus: clearPublishedManagedServer,
    clearHostServerNotes: clearManagedServerNotes,
    store
  })
  registerManagedServerMaintenanceActions({ status: actions.status, update: actions.update })
}
