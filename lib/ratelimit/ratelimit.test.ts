import { afterEach, describe, expect, it } from "vitest";

import { consumeDailyBudget, dailyBudgetUsed, resetDailyBudgets } from "./budget";
import { clientIp, normalizeIp } from "./client-ip";
import { MemoryRateLimitStore } from "./memory-store";
import { RATE_LIMITS } from "./rules";
import type { RateLimitRule } from "./types";

afterEach(() => {
  resetDailyBudgets();
  delete process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;
});

const RULE: RateLimitRule = { name: "test", limit: 3, windowSeconds: 60 };

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

/* ---------------------------------------------------------------------------
 * Client IP — the security-critical part
 * ------------------------------------------------------------------------ */

describe("normalizeIp", () => {
  it("strips a port from an IPv4 address", () => {
    expect(normalizeIp("203.0.113.9:53102")).toBe("203.0.113.9");
  });

  it("leaves a bare IPv6 address intact — it must not truncate at the first colon", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("unwraps a bracketed IPv6 address with a port", () => {
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("trims and lowercases", () => {
    expect(normalizeIp("  2001:DB8::1  ")).toBe("2001:db8::1");
  });
});

describe("clientIp — spoofing resistance", () => {
  it("reads x-forwarded-for from the RIGHT, so a prepended fake does not win", () => {
    // The attack: client sends its own X-Forwarded-For, the proxy appends the
    // address it actually saw. Taking parts[0] would hand the attacker a
    // fresh bucket per forged value.
    const spoofed = headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(clientIp(spoofed)).toBe("203.0.113.9");
  });

  it("gives an attacker the SAME key no matter what they forge", () => {
    const a = clientIp(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
    const b = clientIp(headers({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }));
    const c = clientIp(headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9" }));
    expect(a).toBe("203.0.113.9");
    expect(b).toBe("203.0.113.9");
    expect(c).toBe("203.0.113.9");
  });

  it("handles a single-entry header (proxy replaced rather than appended)", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  /* -------------------------------------------------------------------------
   * These four replace two tests that asserted the OPPOSITE — that `x-real-ip`
   * and `x-vercel-forwarded-for` were PREFERRED over `x-forwarded-for`. The
   * bug was not merely unnoticed; it was pinned as intended behaviour by a
   * passing suite, which is why review never caught it.
   *
   * Measured live on a Vercel preview before the fix: 40 concurrent requests
   * each carrying a unique forged `X-Real-IP` returned 40x200 / 0x429, while
   * the identical burst with no forged header returned 34x200 / 6x429. One
   * header defeated the whole limiter.
   * ---------------------------------------------------------------------- */

  it("IGNORES x-real-ip — a forged one must not mint a fresh bucket", () => {
    const real = clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    const forged = clientIp(
      headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9", "x-real-ip": "198.51.100.77" }),
    );
    expect(forged).toBe(real);
    expect(forged).toBe("203.0.113.9");
  });

  it("gives every forged x-real-ip the SAME bucket, not one each", () => {
    // The actual attack: vary the header per request and get a fresh quota
    // each time. All of these must resolve to one identity.
    const resolved = new Set(
      ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"].map((forged) =>
        clientIp(headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7", "x-real-ip": forged })),
      ),
    );
    expect(resolved.size).toBe(1);
    expect([...resolved][0]).toBe("198.51.100.7");
  });

  it("IGNORES x-vercel-forwarded-for — asserted-not-verified, and absent in practice", () => {
    const h = headers({
      "x-forwarded-for": "1.2.3.4, 203.0.113.9",
      "x-vercel-forwarded-for": "198.51.100.77",
    });
    expect(clientIp(h)).toBe("203.0.113.9");
  });

  it("returns null when ONLY the untrusted headers are present", () => {
    // No x-forwarded-for at all: there is no trustworthy source, so this must
    // report "unknown" rather than fall back to something forgeable.
    // `limiter.ts` buckets unknown callers together, so null is not a bypass.
    expect(
      clientIp(headers({ "x-real-ip": "198.51.100.77", "x-vercel-forwarded-for": "1.2.3.4" })),
    ).toBeNull();
  });

  it("honours a configured hop count for a two-proxy deployment", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "2";
    // client -> CDN -> Vercel -> us. The CDN appended the real client,
    // Vercel appended the CDN.
    const h = headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 198.51.100.7" });
    expect(clientIp(h)).toBe("203.0.113.9");
  });

  it("degrades to the leftmost entry rather than undefined when hops exceed the list", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "99";
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores an invalid hop count and falls back to the default", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "not-a-number";
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("returns null when no forwarding header is present", () => {
    expect(clientIp(headers({}))).toBeNull();
  });

  it("returns null for a header that is only separators", () => {
    expect(clientIp(headers({ "x-forwarded-for": " , , " }))).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Sliding window
 * ------------------------------------------------------------------------ */

describe("MemoryRateLimitStore", () => {
  it("allows up to the limit and denies the next request", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;

    for (let i = 0; i < RULE.limit; i++) {
      const decision = await store.hit("k", RULE, t0);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(RULE.limit - (i + 1));
    }

    const denied = await store.hit("k", RULE, t0);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("keeps separate buckets per key", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < RULE.limit; i++) await store.hit("a", RULE, t0);

    expect((await store.hit("a", RULE, t0)).allowed).toBe(false);
    expect((await store.hit("b", RULE, t0)).allowed).toBe(true);
  });

  it("frees exactly one slot as the oldest entry ages out, not the whole window", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    // Three hits spread one second apart.
    await store.hit("k", RULE, t0);
    await store.hit("k", RULE, t0 + 1_000);
    await store.hit("k", RULE, t0 + 2_000);
    expect((await store.hit("k", RULE, t0 + 3_000)).allowed).toBe(false);

    // Just after the FIRST hit ages out, exactly one slot opens.
    const justAfter = t0 + 60_001;
    expect((await store.hit("k", RULE, justAfter)).allowed).toBe(true);
    expect((await store.hit("k", RULE, justAfter)).allowed).toBe(false);
  });

  it("does not permit a double burst across a window boundary", async () => {
    // The fixed-window failure this design exists to avoid: `limit` requests
    // at the end of one window plus `limit` at the start of the next.
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < RULE.limit; i++) await store.hit("k", RULE, t0 + 59_000);

    // One millisecond into the "next" fixed window — a fixed-window limiter
    // would reset here and allow a full second burst.
    expect((await store.hit("k", RULE, t0 + 60_001)).allowed).toBe(false);
  });

  it("reports a retryAfter that is accurate and never zero", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < RULE.limit; i++) await store.hit("k", RULE, t0);

    // 10s into the window: the oldest entry expires 50s from now.
    const denied = await store.hit("k", RULE, t0 + 10_000);
    expect(denied.retryAfterSeconds).toBe(50);

    // 1ms before the oldest expires: rounds up to 1, never 0.
    const almost = await store.hit("k", RULE, t0 + 59_999);
    expect(almost.retryAfterSeconds).toBe(1);
  });

  it("recovers fully once the whole window has passed", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < RULE.limit; i++) await store.hit("k", RULE, t0);
    expect((await store.hit("k", RULE, t0)).allowed).toBe(false);

    const fresh = await store.hit("k", RULE, t0 + 60_001);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(RULE.limit - 1);
  });

  it("bounds memory by evicting rather than growing without limit", async () => {
    const store = new MemoryRateLimitStore();
    const generous: RateLimitRule = { name: "g", limit: 1000, windowSeconds: 60 };
    const t0 = 1_000_000;

    for (let i = 0; i < 10_050; i++) {
      await store.hit(`ip-${i}`, generous, t0);
    }
    expect(store.size).toBeLessThanOrEqual(10_000);
  });
});

/* ---------------------------------------------------------------------------
 * Daily budget
 * ------------------------------------------------------------------------ */

describe("consumeDailyBudget", () => {
  const day1 = new Date("2026-07-31T12:00:00Z");
  const day2 = new Date("2026-08-01T00:30:00Z");

  it("allows up to the limit then refuses", () => {
    for (let i = 0; i < 3; i++) {
      expect(consumeDailyBudget("omdb", 3, day1)).toBe(true);
    }
    expect(consumeDailyBudget("omdb", 3, day1)).toBe(false);
    expect(dailyBudgetUsed("omdb", day1)).toBe(3);
  });

  it("does not increment past the limit once exhausted", () => {
    for (let i = 0; i < 5; i++) consumeDailyBudget("omdb", 2, day1);
    expect(dailyBudgetUsed("omdb", day1)).toBe(2);
  });

  it("rolls over on the UTC day boundary", () => {
    for (let i = 0; i < 3; i++) consumeDailyBudget("omdb", 3, day1);
    expect(consumeDailyBudget("omdb", 3, day1)).toBe(false);

    // Next UTC day: a fresh allowance.
    expect(consumeDailyBudget("omdb", 3, day2)).toBe(true);
    expect(dailyBudgetUsed("omdb", day2)).toBe(1);
  });

  it("keeps separate budgets per name", () => {
    consumeDailyBudget("omdb", 1, day1);
    expect(consumeDailyBudget("omdb", 1, day1)).toBe(false);
    expect(consumeDailyBudget("other", 1, day1)).toBe(true);
  });

  it("reports zero used for a day with no spend", () => {
    expect(dailyBudgetUsed("omdb", day1)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * The configured rules
 * ------------------------------------------------------------------------ */

describe("RATE_LIMITS", () => {
  it("keeps the quota-bound route strictly tighter than the others", () => {
    // OMDb is the only hard external cap (1,000/day), so this ordering is a
    // correctness property, not a preference.
    expect(RATE_LIMITS.ratings.limit).toBeLessThan(RATE_LIMITS.search.limit);
    expect(RATE_LIMITS.search.limit).toBeLessThan(RATE_LIMITS.read.limit);
  });

  it("gives every rule a distinct name so buckets cannot collide", () => {
    const names = Object.values(RATE_LIMITS).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leaves headroom for a normal page view, which fires ~6 requests", () => {
    expect(RATE_LIMITS.read.limit).toBeGreaterThanOrEqual(60);
  });
});
