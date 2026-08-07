import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

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
};

export default nextConfig;
