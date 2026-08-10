/**
 * What this browser can actually do, and — when it can't — WHY, in a form the
 * UI can turn into a real explanation.
 *
 * ============================================================================
 * CAPABILITY-BASED, NEVER VERSION-SNIFFED
 * ============================================================================
 * The iOS floor for Web Push is commonly cited as 16.4 plus home-screen
 * install. This module never checks for that version, and the UI never prints
 * it. Two reasons: a UA-string version check is wrong the moment Apple ships
 * the next thing, and `docs/phase-7-notifications-design.md` §0 flags that
 * exact number as ASSERTED rather than verified. Feature-detecting
 * `PushManager` is both correct today and correct after the floor moves.
 *
 * The one place a platform IS identified is `ios-not-installed`, and even
 * there the platform check only decides which EXPLANATION to show — the
 * blocking condition is still the missing `PushManager`.
 */

export type PushCapability =
  /** Everything present. The toggle can be offered. */
  | { kind: "supported" }
  /** iOS Safari, not installed to the home screen. Actionable — show the
   *  Add to Home Screen instructions rather than a disabled control. */
  | { kind: "ios-not-installed" }
  /** Permission was denied at some point. Cannot be re-prompted from script;
   *  only the user can undo it, in browser settings. */
  | { kind: "permission-denied" }
  /** No push support at all, and nothing the user can do about it. */
  | { kind: "unsupported" }
  /** Server render, or before the first effect has run. Render nothing —
   *  never a disabled control, which would flash on every page load. */
  | { kind: "unknown" };

/** Deliberately narrow: this identifies iOS ONLY to pick which explanation to
 *  show, never to gate the feature. iPadOS 13+ reports as a Mac, which is why
 *  the touch-points check is included. */
function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // Safari's own non-standard flag, still the only signal on older iOS.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function detectPushCapability(): PushCapability {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { kind: "unknown" };
  }

  const hasWorker = "serviceWorker" in navigator;
  const hasPush = "PushManager" in window;
  const hasNotification = "Notification" in window;

  if (hasWorker && hasPush && hasNotification) {
    // Checked AFTER support, so a denied permission on a capable browser is
    // reported as denied (recoverable in settings) rather than unsupported.
    return Notification.permission === "denied"
      ? { kind: "permission-denied" }
      : { kind: "supported" };
  }

  // On iOS the missing PushManager is not permanent — installing to the home
  // screen provides it. That is the difference between "you can't" and
  // "here's how", and it is the whole reason this branch exists.
  if (isIosLike() && !isStandalone()) return { kind: "ios-not-installed" };

  return { kind: "unsupported" };
}
