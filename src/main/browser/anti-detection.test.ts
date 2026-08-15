import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { ANTI_DETECTION_SCRIPT } from './anti-detection'

type PermissionQueryResult = {
  state: string
  onchange: null
}

type AntiDetectionContext = {
  Notification: {
    permission: string
    requestPermission: (callback?: (permission: string) => void) => Promise<string>
  }
  navigator: {
    permissions: {
      query: (descriptor: { name: string }) => Promise<PermissionQueryResult>
    }
  }
}

function createContext(args: {
  nativeNotificationPermission: string
  requestedNotificationPermission: string
}): AntiDetectionContext & Record<string, unknown> {
  // Why: the real Permissions.query resolves a PermissionStatus, so the stand-in must carry the
  // listener methods too — otherwise the test cannot tell a proxied status from a bare literal.
  class PermissionStatus {
    state = 'denied'
    onchange = null
    marker = 'real-status'
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  class Permissions {
    query(): Promise<PermissionQueryResult> {
      return Promise.resolve(new PermissionStatus() as unknown as PermissionQueryResult)
    }
  }

  const Notification = {
    permission: args.nativeNotificationPermission,
    requestPermission(callback?: (permission: string) => void): Promise<string> {
      callback?.(args.requestedNotificationPermission)
      return Promise.resolve(args.requestedNotificationPermission)
    }
  }
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => args.nativeNotificationPermission
  })

  return {
    Date,
    Object,
    Promise,
    Set,
    performance: { now: () => 0 },
    window: {},
    navigator: {
      plugins: [],
      languages: [],
      permissions: new Permissions()
    },
    Permissions,
    Notification
  } as AntiDetectionContext & Record<string, unknown>
}

describe('ANTI_DETECTION_SCRIPT', () => {
  it('reports notification permission as granted after a site permission request succeeds', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.Notification.permission).toBe('default')
    expect((await context.navigator.permissions.query({ name: 'notifications' })).state).toBe(
      'prompt'
    )

    await expect(context.Notification.requestPermission()).resolves.toBe('granted')

    expect(context.Notification.permission).toBe('granted')
    expect((await context.navigator.permissions.query({ name: 'notifications' })).state).toBe(
      'granted'
    )
  })

  it('keeps the real PermissionStatus so listeners can still be registered', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    // Why: the override used to return a bare object literal, so any site doing
    // query(...).then(s => s.addEventListener('change', ...)) threw a TypeError.
    for (const name of ['notifications', 'storage-access', 'geolocation']) {
      const status = (await context.navigator.permissions.query({ name })) as unknown as {
        addEventListener: unknown
        removeEventListener: unknown
        state: string
        marker: string
      }
      expect(typeof status.addEventListener).toBe('function')
      expect(typeof status.removeEventListener).toBe('function')
      // Why: proxying the genuine status must not drop its other properties.
      expect(status.marker).toBe('real-status')
    }
  })

  it('preserves notification permission when Electron already reports a grant', async () => {
    const context = createContext({
      nativeNotificationPermission: 'granted',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.Notification.permission).toBe('granted')
    expect((await context.navigator.permissions.query({ name: 'notifications' })).state).toBe(
      'granted'
    )
  })
})
