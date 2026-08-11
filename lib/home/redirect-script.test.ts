import { describe, expect, it, vi } from "vitest";

import { FIRST_PAGE_PATH } from "./types";
import { buildFirstPageRedirectScript } from "./redirect-script";

/**
 * The script text is EXECUTED here, not just pattern-matched — a redirect
 * bug here means a user opens the app and lands somewhere they didn't
 * choose, on every cold load, which is worth the strongest coverage this
 * suite can give it.
 *
 * `new Function("localStorage", "location", body)` runs the real generated
 * source with fake `localStorage`/`location` as its own parameters —
 * parameter scoping shadows anything of the same name in the surrounding
 * environment, so this works whether or not the test runner's global scope
 * happens to provide either one.
 */
function run(
  script: string,
  { pathname, raw }: { pathname: string; raw: string | null },
): { replacedTo: string | null } {
  let replacedTo: string | null = null;
  const location = {
    pathname,
    replace(url: string) {
      replacedTo = url;
    },
  };
  const localStorage = {
    getItem: vi.fn(() => raw),
  };
  // Deliberately executing the real generated source — see doc comment above.
  const runner = new Function("localStorage", "location", script);
  runner(localStorage, location);
  return { replacedTo };
}

function envelope(firstPage: unknown): string {
  return JSON.stringify({ v: 1, d: { firstPage } });
}

describe("buildFirstPageRedirectScript", () => {
  it("embeds the real storage key and FIRST_PAGE_PATH — guards the guard", () => {
    const script = buildFirstPageRedirectScript();
    expect(script).toContain("marquee:home-config:config");
    expect(script).toContain(JSON.stringify(FIRST_PAGE_PATH));
  });

  it("does nothing on a path other than '/', even with a non-default preference stored", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/library", raw: envelope("search") });
    expect(replacedTo).toBeNull();
  });

  it("does nothing when nothing is stored yet — the zero-config default", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: null });
    expect(replacedTo).toBeNull();
  });

  it("does nothing when firstPage is explicitly 'home'", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: envelope("home") });
    expect(replacedTo).toBeNull();
  });

  it.each([
    ["library", "/library"],
    ["schedule", "/schedule"],
    ["search", "/search"],
  ] as const)("redirects '/' to %s's path when that is the configured first page", (page, path) => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: envelope(page) });
    expect(replacedTo).toBe(path);
  });

  it("does nothing for a corrupted firstPage value rather than throwing", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: envelope("not-a-real-page") });
    expect(replacedTo).toBeNull();
  });

  it("does nothing for unparseable JSON rather than throwing", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: "{not json" });
    expect(replacedTo).toBeNull();
  });

  it("does nothing for an envelope missing `d` rather than throwing", () => {
    const script = buildFirstPageRedirectScript();
    const { replacedTo } = run(script, { pathname: "/", raw: JSON.stringify({ v: 1 }) });
    expect(replacedTo).toBeNull();
  });

  it("survives localStorage.getItem itself throwing (blocked storage)", () => {
    const script = buildFirstPageRedirectScript();
    let replacedTo: string | null = null;
    const location = {
      pathname: "/",
      replace(url: string) {
        replacedTo = url;
      },
    };
    const localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => {
      // Deliberately executing the real generated source — see doc comment above.
      const runner = new Function("localStorage", "location", script);
      runner(localStorage, location);
    }).not.toThrow();
    expect(replacedTo).toBeNull();
  });
});
