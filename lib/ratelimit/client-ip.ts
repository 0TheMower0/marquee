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
 *
 * ============================================================================
 * WHY `X-Real-IP` IS NOT CONSULTED, AND MUST NOT BE RE-ADDED
 * ============================================================================
 * It used to be, checked BEFORE the list above and returned unconditionally,
 * with a comment claiming it was "single-valued and proxy-set on most
 * platforms, including Vercel." That was never verified, and it is false on
 * Vercel: a live three-way burst against a preview deployment measured 40/40
 * requests succeeding when each carried a unique forged `X-Real-IP`, against
 * 34/40 with 6 rejections for the identical burst with no forged header. One
 * header defeated the entire limiter.
 *
 * This is NOT a Vercel quirk — it is a property of the header itself, and the
 * distinction is what makes the rule general:
 *
 *   - `X-Forwarded-For` is APPEND-ONLY. A conforming proxy appends the peer
 *     address it observed, so a forged prefix is still there but the Nth entry
 *     from the right is proxy-written. You can count PAST the forgery.
 *   - `X-Real-IP` is a SCALAR. There is no proxy-written part to count to.
 *     Either the proxy overwrote the whole value or it did not, and the
 *     application cannot tell by inspection.
 *
 * So trusting it means trusting a deployment configuration this code cannot
 * verify. It is also not in any RFC — it is an nginx convention
 * (`proxy_set_header X-Real-IP $remote_addr`). Behind such an nginx it happens
 * to be safe; behind anything else it is attacker-controlled, and it flips
 * silently when someone adds a hop.
 *
 * `X-Vercel-Forwarded-For` was removed for the same reason, one level worse:
 * it was checked FIRST and asserted to be proxy-set, and the same burst is
 * evidence it is simply ABSENT on Vercel requests — forging `X-Real-IP` could
 * not have bypassed anything if the branch above it had returned a value. An
 * untested trusted-input path that never fires is not defence, it is a hole
 * waiting for the header to start appearing.
 *
 * The lesson, since it happened twice in one function: an unverified
 * assumption placed AHEAD of a verified one means the verified code never
 * runs. If a platform-specific source is ever genuinely wanted, use the
 * supported API (`ipAddress()` from `@vercel/functions`), not a header whose
 * provenance is a guess.
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
  // `X-Forwarded-For` is the ONLY source consulted, deliberately. See the
  // header comment for why `X-Real-IP` and `X-Vercel-Forwarded-For` were
  // removed and must not come back — both were trusted on an assertion, and
  // one of them was measured defeating the limiter outright.
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
