// geolocation.js
// Robust geolocation with permission preflight, fast fallback, and normalized errors.

/**
 * @typedef {Object} GeoOptions
 * @property {number} [timeoutMs=15000]           Max time to wait for a reading.
 * @property {boolean} [highAccuracy=true]        Try high-accuracy first.
 * @property {boolean} [fallbackLowAccuracy=true] Fall back to low-accuracy if high-accuracy is slow/fails.
 * @property {number} [highAccGraceMs=3500]       If high-accuracy doesn't return within this window, try low-accuracy.
 */

/**
 * @typedef {Object} GeoSuccess
 * @property {'success'} status
 * @property {GeolocationPosition} position
 * @property {boolean} isPrecise              // accuracy heuristic (<= 50m)
 * @property {'high-accuracy'|'low-accuracy'} source
 * @property {number} elapsedMs
 * @property {'granted'|'denied'|'prompt'|null} permission
 */

/**
 * @typedef {Object} GeoError
 * @property {'error'} status
 * @property {'unsupported'|'insecure_context'|'denied'|'timeout'|'unavailable'|'unknown'} code
 * @property {string} message
 * @property {'granted'|'denied'|'prompt'|null} permission
 */

export async function getGeolocation(/** @type {GeoOptions} */ opts = {}) {
  const {
    timeoutMs = 15000,
    highAccuracy = true,
    fallbackLowAccuracy = true,
    highAccGraceMs = 3500,
  } = opts;

  const start = performance.now();

  // 1) Basic capability & context checks
  if (!('geolocation' in navigator)) {
    return {
      status: 'error',
      code: 'unsupported',
      message: 'Geolocation is not supported by this browser.',
      permission: null,
    };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    // Most browsers require HTTPS (or localhost) for geolocation
    return {
      status: 'error',
      code: 'insecure_context',
      message: 'Geolocation requires a secure context (HTTPS or localhost).',
      permission: null,
    };
  }

  // 2) Permission preflight (best effort)
  /** @type {'granted'|'denied'|'prompt'|null} */
  let permission = null;
  try {
    if (navigator.permissions?.query) {
      const r = await navigator.permissions.query({ name: 'geolocation' });
      permission = r.state; // 'granted' | 'denied' | 'prompt'
      // (Optional) Listen for changes: r.onchange = () => console.log(r.state);
    }
  } catch {
    // Ignore; not supported on all browsers/iframes.
  }

  // Helper to promisify getCurrentPosition
  const requestPosition = (/** @type {PositionOptions} */ options) =>
    new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });

  // Normalize GeolocationPositionError to a friendly code/message
  const normalizeError = (err) => {
    // Some browsers use code: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
    switch (err?.code) {
      case 1:
        return { code: 'denied', message: 'Location permission denied.' };
      case 2:
        return { code: 'unavailable', message: 'Location is unavailable.' };
      case 3:
        return { code: 'timeout', message: 'Location request timed out.' };
      default:
        return { code: 'unknown', message: err?.message || 'Unknown geolocation error.' };
    }
  };

  // Compose options for high & low accuracy attempts
  const highAccOptions = /** @type {PositionOptions} */ ({
    enableHighAccuracy: !!highAccuracy,
    timeout: Math.max(1, Math.min(timeoutMs, 30000)), // clamp hard upper bound
    maximumAge: 0,
  });
  const lowAccOptions = /** @type {PositionOptions} */ ({
    enableHighAccuracy: false,
    timeout: Math.max(1, Math.min(timeoutMs, 30000)),
    // Allow small cache to improve speed if user moved recently; adjust as desired
    maximumAge: 60 * 1000,
  });

  // Race helpers
  const withTimeout = (p, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject({ code: 'timeout', message: 'Timed out.' }), ms);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });

  try {
    // Strategy:
    //  - Kick off high-accuracy.
    //  - If it doesn't return within highAccGraceMs, optionally start low-accuracy too.
    //  - Whichever returns first wins (if acceptable); if first fails and we have a second, let it continue.
    const highAccPromise = requestPosition(highAccOptions);

    let winnerPromise = highAccPromise;

    let lowAccStarted = false;
    let lowAccPromise;

    // After grace window, start low-accuracy if allowed
    const grace = new Promise((resolve) => setTimeout(resolve, highAccGraceMs));
    await Promise.race([highAccPromise, grace]).catch(() => { /* ignore */ });

    if (fallbackLowAccuracy && !isSettled(highAccPromise)) {
      lowAccStarted = true;
      lowAccPromise = requestPosition(lowAccOptions);
      // Make whichever resolves first the "winner"
      winnerPromise = Promise.race([highAccPromise, lowAccPromise]);
    }

    const pos = await withTimeout(winnerPromise, timeoutMs);

    // Heuristic: consider <= 50m as precise
    const isPrecise = pos?.coords?.accuracy != null ? pos.coords.accuracy <= 50 : false;

    const elapsedMs = Math.round(performance.now() - start);
    /** @type {'high-accuracy'|'low-accuracy'} */
    const source = lowAccStarted && pos === await maybePeek(lowAccPromise) ? 'low-accuracy' : 'high-accuracy';

    return {
      status: 'success',
      position: pos,
      isPrecise,
      source,
      elapsedMs,
      permission,
    };
  } catch (err) {
    const { code, message } = normalizeError(err);
    return {
      status: 'error',
      code,
      message,
      permission,
    };
  }

  // Helpers to introspect/race promises without awaiting to resolution elsewhere
  function isSettled(promise) {
    // There is no standard way to check settlement; this is a hack via Promise.race microtask.
    // We avoid heavy machinery here; instead we rely on the grace timer to decide starting fallback.
    return false;
  }
  async function maybePeek(p) {
    try { return await Promise.race([p, Promise.resolve(Symbol('noop'))]); }
    catch { return null; }
  }
}