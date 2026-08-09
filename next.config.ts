import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * The build id baked into the service worker's registration URL
 * (`/sw.js?v=…`), which is what makes a deploy produce a new worker and
 * therefore an update. See components/pwa/service-worker-registration.tsx.
 *
 * ============================================================================
 * WHY A GIT SHA AND NOT A TIMESTAMP
 * ============================================================================
 * It must be DETERMINISTIC. `next.config.ts` can be evaluated more than once
 * during a build, and `env` values are inlined into the client bundle from
 * whichever evaluation the compiler used — a `Date.now()` here could in
 * principle inline two different versions into two different chunks, which is
 * exactly the class of bug that only appears after deploy. A commit SHA is
 * the same on every evaluation and changes on every real deploy.
 *
 * Known limitation, stated rather than hidden: uncommitted local changes do
 * NOT bump this, so a rebuilt-but-uncommitted worker looks unchanged to the
 * browser. That never happens on Vercel (every deploy is a commit); locally,
 * set `SW_VERSION` to force one while testing update behaviour.
 */
function serviceWorkerVersion(): string {
  if (process.env.SW_VERSION) return process.env.SW_VERSION;
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  }
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // No git (a tarball build, say). "dev" is a stable fallback — it means
    // updates rely on the worker's own bytes changing, which is still true.
    return "dev";
  }
}

/**
 * Every non-loopback IPv4 address this machine currently has.
 *
 * ============================================================================
 * WHY THIS EXISTS — READ BEFORE DELETING IT
 * ============================================================================
 * Next 16 "blocks cross-origin requests to dev-only assets and endpoints
 * during development by default to prevent unauthorized access"
 * (node_modules/next/dist/docs/.../allowedDevOrigins.md). The dev server is
 * initialized with `localhost`, so opening `http://192.168.1.112:3000` from a
 * phone on the same network is a *cross-origin* request to `/_next/*` and is
 * refused.
 *
 * The way that manifests is genuinely nasty and cost a long debugging session:
 * the HTML renders fine, so the page looks alive, but the HMR WebSocket
 * handshake fails with `ERR_INVALID_HTTP_RESPONSE` and **hydration never
 * completes**. Every Client Component is then inert SSR markup — tracking
 * controls stay `disabled`, My Library sits on its loading skeletons forever,
 * and even a diagnostics panel built specifically to explain the problem
 * cannot be clicked. Navigation still works, because `<Link>` renders a real
 * `<a href>` that needs no JavaScript, which makes the app look *mostly* fine
 * and sends you hunting in the wrong place.
 *
 * Critically: **no exception is thrown**, so there is nothing in the console
 * except the WebSocket error, and no error boundary fires. Verified with
 * headless Chrome over CDP against both origins — see the Phase 6 Step 5c
 * notes in CLAUDE.md.
 *
 * Detected rather than hardcoded so this keeps working on any machine, on any
 * network, after any DHCP lease change — hardcoding one IP would fix today's
 * laptop and break the next one, silently and in the same confusing way.
 *
 * `allowedDevOrigins` is ignored in production builds, so this has no effect
 * on a deployed app.
 */
function localNetworkOrigins(): string[] {
  const found = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) found.add(address.address);
    }
  }
  return [...found];
}

const nextConfig: NextConfig = {
  /**
   * Additional origins allowed to request dev-only assets. Loopback is already
   * permitted; this adds this machine's LAN addresses so a phone can reach the
   * dev server. `DEV_ALLOWED_ORIGINS` (comma-separated) is the escape hatch
   * for anything auto-detection cannot see — a tunnel hostname, a container
   * bridge, a VPN address.
   */
  allowedDevOrigins: [
    ...localNetworkOrigins(),
    ...(process.env.DEV_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()) ?? []),
  ].filter(Boolean),

  images: {
    // TMDB image paths are size-templated (e.g. /t/p/w342/<hash>.jpg) — the
    // wildcard covers every size string lib/content/tmdb/normalize.ts might
    // request without needing a config change every time that map grows.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },

  env: {
    NEXT_PUBLIC_SW_VERSION: serviceWorkerVersion(),
  },

  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          /**
           * HALF of the stale-worker guard; the other half is
           * `updateViaCache: "none"` at registration. Either alone is
           * insufficient — see the long note in
           * components/pwa/service-worker-registration.tsx.
           *
           * Without both, a browser or CDN can serve a day-old worker and
           * there is NO recovery path from inside the app: the stale worker
           * is the thing that would have to fetch its own replacement.
           */
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          // Files in `public/` are served with a content type sniffed from the
          // extension, which is already correct here. Pinned anyway because a
          // worker script served as anything but JavaScript fails to register
          // with an error that does not obviously name the cause.
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
