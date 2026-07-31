/**
 * Resolving the caller's IP behind a reverse proxy.
 *
 * ============================================================================
 * WHY THIS IS NOT `request.ip`
 * ============================================================================
 * `NextRequest.ip` and `.geo` were REMOVED in Next 15 (see
 * `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-15.md`) —
 * those values come from the hosting provider now, not the framework. On
 * Vercel the supported replacement is `ipAddress()` from `@vercel/functions`.
 * We read headers directly instead, so this works identically on Vercel,
 * self-hosted Node, and in tests, without adding a platform-specific
 * dependency for one string.
 *
 * ============================================================================
 * THE TRUST MODEL — the part that decides whether this is bypassable
 * ============================================================================
 * `X-Forwarded-For` is a CLIENT-SUPPLIED header. Anyone can send
 * `X-Forwarded-For: 1.2.3.4`. What saves us is that a proxy in front
 * *appends* the address it actually observed, so the header becomes
 * `1.2.3.4, <real client>`.
 *
 * That is why this reads the list **from the RIGHT, not the left.** The
 * common `parts[0]` idiom is exactly the bug: it hands an attacker a fresh
 * rate-limit bucket per forged value, which silently defeats the entire
 * limiter. Counting from the right is also correct in the case where the
 * proxy *replaces* the header outright (a one-element list reads the same
 * from either end), so it is the safe choice under both behaviours.
 *
 * `TRUSTED_PROXY_HOPS` is how many proxies sit in front of us. Vercel is one,
 * which is the default. Put Cloudflare in front of Vercel and it becomes 2;
 * get it wrong in the "too many" direction and you read an attacker-controlled
 * value, so this is deliberately explicit rather than guessed at runtime.
 *
 * ⚠️ On a deployment with NO proxy in front, `X-Forwarded-For` is entirely
 * attacker-controlled and per-IP limiting is best-effort at most. That is a
 * real limitation, not a solved problem — it is precisely why the global
 * budget in `budget.ts` exists as a backstop that IP spoofing cannot evade.
 */

const DEFAULT_TRUSTED_PROXY_HOPS = 1;

function trustedProxyHops(): number {
  const raw = process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TRUSTED_PROXY_HOPS;
  return parsed;
}

/**
 * Strips a trailing port and IPv6 brackets. Some proxies emit `1.2.3.4:53102`
 * or `[::1]:53102`; treating those as distinct callers would hand every
 * connection its own bucket, since the source port changes per connection.
 */
export function normalizeIp(value: string): string {
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("[")) {
    // `[::1]:port` or `[::1]` — the bracketed part is the address.
    const close = ip.indexOf("]");
    if (close !== -1) return ip.slice(1, close);
  }
  // Only strip a port from IPv4 (`a.b.c.d:port`). A bare IPv6 address is full
  // of colons and must never be truncated at the first one.
  const colons = ip.split(":").length - 1;
  if (colons === 1) ip = ip.slice(0, ip.indexOf(":"));
  return ip;
}

/**
 * The caller's IP, or `null` when it genuinely cannot be determined.
 *
 * Callers must decide what `null` means for them — `limiter.ts` buckets all
 * unidentifiable callers together rather than letting them through, so a
 * missing header is not a bypass.
 */
export function clientIp(headers: Headers): string | null {
  // Set by Vercel's own proxy rather than forwarded from the client, so it
  // is not subject to the prepending trick above.
  const vercelForwarded = headers.get("x-vercel-forwarded-for");
  if (vercelForwarded) {
    const parts = splitForwarded(vercelForwarded);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  // Single-valued and proxy-set on most platforms, including Vercel.
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const normalized = normalizeIp(realIp);
    if (normalized) return normalized;
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = splitForwarded(forwarded);
    if (parts.length > 0) {
      // Count from the right by the number of proxies we trust. Clamped, so a
      // misconfigured hop count degrades to "the leftmost entry" rather than
      // reading undefined.
      const index = Math.max(0, parts.length - trustedProxyHops());
      return parts[index] ?? parts[0];
    }
  }

  return null;
}

function splitForwarded(header: string): string[] {
  return header
    .split(",")
    .map((part) => normalizeIp(part))
    .filter((part) => part.length > 0);
}
