// Why: Cloudflare Turnstile and similar bot detectors probe multiple browser
// APIs beyond navigator.webdriver. This script runs via
// Page.addScriptToEvaluateOnNewDocument before any page JS to mask automation
// signals that CDP debugger attachment and Electron's webview expose.
export const ANTI_DETECTION_SCRIPT = `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  // Why: Electron webviews expose an empty plugins array. Real Chrome always
  // has at least a few default plugins (PDF Viewer, etc.). An empty array is
  // a strong automation signal.
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ]
    });
  }
  // Why: Electron webviews may not have the window.chrome object that real
  // Chrome exposes. Turnstile checks for its presence. The csi() and
  // loadTimes() stubs satisfy deeper probes that check for these Chrome-
  // specific APIs beyond just chrome.runtime.
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        startE: Date.now(),
        onloadT: Date.now(),
        pageT: performance.now(),
        tran: 15
      };
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 0.16,
        startLoadTime: Date.now() / 1000 - 0.3,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      };
    };
  }
  // Why: Electron's Permission API defaults to 'denied' for most permissions,
  // but real Chrome returns 'prompt' for ungranted permissions. Returning
  // 'denied' is a strong bot signal. Override the query result for common
  // permissions that Turnstile and similar detectors probe.
  var notificationPermission = 'default';
  var setNotificationPermission = function(permission) {
    if (permission === 'granted' || permission === 'denied') {
      notificationPermission = permission;
      return permission;
    }
    notificationPermission = 'default';
    return 'default';
  };
  var notificationPermissionState = function() {
    return notificationPermission === 'default' ? 'prompt' : notificationPermission;
  };
  try {
    if (Notification.permission === 'granted') {
      notificationPermission = 'granted';
    }
  } catch {}
  const promptPerms = new Set([
    'geolocation', 'camera', 'microphone',
    'midi', 'idle-detection', 'storage-access'
  ]);
  const origQuery = Permissions.prototype.query;
  // Why: returning a bare object literal dropped the PermissionStatus prototype, so a site doing
  // query(...).then(s => s.addEventListener('change', ...)) threw a TypeError — real Chrome returns
  // a PermissionStatus. Proxy the genuine status and override only 'state' so the prototype,
  // events and instanceof survive.
  function withOverriddenState(realStatus, state) {
    return new Proxy(realStatus, {
      get(target, prop) {
        if (prop === 'state') {
          return state;
        }
        const value = Reflect.get(target, prop, target);
        // Why: methods need the real receiver, but binding 'constructor' too would make
        // constructor.name read 'bound PermissionStatus' — a fresh tell in the file that exists
        // to remove them.
        return typeof value === 'function' && prop !== 'constructor' ? value.bind(target) : value;
      }
    });
  }
  // Why: some names the real implementation rejects outright; fall back to an EventTarget so
  // listener registration still works instead of throwing.
  function fallbackStatus(name, state) {
    const status = new EventTarget();
    Object.defineProperties(status, {
      name: { get: () => name, enumerable: true },
      state: { get: () => state, enumerable: true },
      onchange: { value: null, writable: true, enumerable: true }
    });
    return status;
  }
  function queryWithState(permissions, desc, state) {
    let real;
    try {
      real = origQuery.call(permissions, desc);
    } catch {
      return Promise.resolve(fallbackStatus(desc.name, state));
    }
    return Promise.resolve(real).then(
      (status) => withOverriddenState(status, state),
      () => fallbackStatus(desc.name, state)
    );
  }
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') {
      return queryWithState(this, desc, notificationPermissionState());
    }
    if (promptPerms.has(desc.name)) {
      return queryWithState(this, desc, 'prompt');
    }
    return origQuery.call(this, desc);
  };
  // Why: Electron may report Notification.permission as 'denied' by default
  // whereas real Chrome reports 'default' for sites that haven't been granted
  // or blocked. Turnstile cross-references this with the Permissions API.
  try {
    Object.defineProperty(Notification, 'permission', {
      get: () => notificationPermission
    });
    const origRequestPermission = Notification.requestPermission;
    if (typeof origRequestPermission === 'function') {
      Notification.requestPermission = function(callback) {
        var wrappedCallback = typeof callback === 'function'
          ? function(permission) {
              callback(setNotificationPermission(permission));
            }
          : undefined;
        var result = origRequestPermission.call(Notification, wrappedCallback);
        if (result && typeof result.then === 'function') {
          return result.then(function(permission) {
            return setNotificationPermission(permission);
          });
        }
        return result;
      };
    }
  } catch {}
  // Why: Electron webviews may have an empty languages array. Real Chrome
  // always has at least one entry. An empty array is an automation signal.
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
  }
})()`
