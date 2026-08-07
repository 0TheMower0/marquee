"use client";

import { useEffect } from "react";

/**
 * Marks the document as hydrated.
 *
 * ============================================================================
 * THE FAILURE THIS EXISTS FOR
 * ============================================================================
 * If hydration never completes, **no client JavaScript runs at all** — which
 * means no React-rendered warning can ever appear to say so. Every diagnostic
 * this app has is a Client Component, and all of them are useless in exactly
 * the situation they were built for. A live two-device test proved that the
 * hard way: the tracking controls were inert, My Library sat on its loading
 * skeletons, and the diagnostics panel added specifically to explain such a
 * state could not be clicked either.
 *
 * The app still *looked* mostly fine, because `<Link>` renders a real
 * `<a href>` and navigation needs no JavaScript. That is what makes this
 * failure so misleading: everything cheap works, everything stateful is dead,
 * and nothing says why.
 *
 * So the warning is rendered by the SERVER, into the HTML, and this component
 * is what takes it away. Inverted from the obvious design on purpose: the
 * message that must survive a total JS failure cannot be the one that depends
 * on JS to appear.
 *
 * Setting a `data-` attribute on <html> rather than unmounting a sibling keeps
 * this decoupled — the warning markup is a Server Component and never needs to
 * know this exists.
 */
export function HydrationFlag() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return null;
}

/**
 * The banner itself — plain markup in the server HTML, hidden by CSS once
 * `HydrationFlag` marks the document hydrated.
 *
 * It is invisible for the first several seconds (see `.interactivity-warning`
 * in globals.css), so a normal load never flashes it: hydration finishes in
 * tens of milliseconds and removes it long before the reveal. Only a page that
 * is *still* not interactive after the delay ever shows it.
 *
 * Deliberately NOT a `<noscript>`. That covers "JavaScript is switched off",
 * which is not the interesting case — the interesting one is JavaScript that
 * loaded and then failed, where `<noscript>` renders nothing at all.
 */
export function InteractivityWarning() {
  return (
    <div className="interactivity-warning" role="alert">
      <p className="text-body-sm font-medium">This page isn&rsquo;t fully loaded</p>
      <p className="text-meta">
        Buttons and your library won&rsquo;t work until it finishes. Reloading
        usually fixes it. If it keeps happening, something is blocking the
        page&rsquo;s scripts &mdash; an extension, a strict privacy mode, or a
        development server reached from another device.
      </p>
      <p className="text-meta">
        Nothing you&rsquo;ve tracked has been lost &mdash; it just can&rsquo;t
        be read until the page loads properly.
      </p>
    </div>
  );
}
