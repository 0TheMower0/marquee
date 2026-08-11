import { describe, expect, it } from "vitest";

import { isTitleSummary } from "./validate";
import type { TitleSummary } from "./types";

/**
 * Phase 8 Step 3. These pin BOTH directions, and the lenient direction is the
 * one with teeth: `lib/storage` treats a record failing `validate()` as
 * unreadable, so a validator that rejected shapes real users already hold
 * would empty their library on the next load. Every "accepts" test below is
 * therefore a guarantee about not destroying data, not a nicety.
 */

function summary(overrides: Record<string, unknown> = {}): unknown {
  const base: TitleSummary = {
    id: "the-godfather",
    mediaType: "movie",
    name: "The Godfather",
    year: 1972,
    overview: "A crime family saga.",
    genres: [{ id: "drama", name: "Drama" }],
    posterUrl: null,
    placeholder: { gradientFrom: "#3a2908", gradientTo: "#e8b33c" },
    rating: 8.7,
  };
  return { ...base, ...overrides };
}

describe("isTitleSummary — rejects what actually crashes", () => {
  it("accepts a complete, real summary", () => {
    expect(isTitleSummary(summary())).toBe(true);
  });

  it("rejects a summary with NO placeholder — the exact production crash", () => {
    // PosterImage reads placeholder.gradientFrom unguarded; undefined here
    // threw during render and took Library, Schedule and Up Next to the error
    // boundary with "Something broke".
    const { placeholder: _omit, ...rest } = summary() as Record<string, unknown>;
    void _omit;
    expect(isTitleSummary(rest)).toBe(false);
  });

  it("rejects a placeholder missing either gradient stop", () => {
    expect(isTitleSummary(summary({ placeholder: { gradientFrom: "#000" } }))).toBe(false);
    expect(isTitleSummary(summary({ placeholder: { gradientTo: "#fff" } }))).toBe(false);
  });

  it("rejects a placeholder whose stops are not strings", () => {
    // Interpolated straight into a CSS gradient — a number would produce a
    // silently broken background rather than a crash, which is worse.
    expect(isTitleSummary(summary({ placeholder: { gradientFrom: 0, gradientTo: 1 } }))).toBe(false);
  });

  it("rejects missing or non-string identity fields", () => {
    expect(isTitleSummary(summary({ id: undefined }))).toBe(false);
    expect(isTitleSummary(summary({ id: 123 }))).toBe(false);
    expect(isTitleSummary(summary({ name: undefined }))).toBe(false);
  });

  it("rejects an unknown mediaType", () => {
    expect(isTitleSummary(summary({ mediaType: "episode" }))).toBe(false);
    expect(isTitleSummary(summary({ mediaType: undefined }))).toBe(false);
  });

  it("rejects non-objects outright", () => {
    expect(isTitleSummary(null)).toBe(false);
    expect(isTitleSummary(undefined)).toBe(false);
    expect(isTitleSummary("the-godfather")).toBe(false);
    expect(isTitleSummary(42)).toBe(false);
  });
});

describe("isTitleSummary — lenient where rejecting would destroy real data", () => {
  it("accepts a summary with no overview", () => {
    const { overview: _o, ...rest } = summary() as Record<string, unknown>;
    void _o;
    expect(isTitleSummary(rest)).toBe(true);
  });

  it("accepts a summary with no genres", () => {
    const { genres: _g, ...rest } = summary() as Record<string, unknown>;
    void _g;
    expect(isTitleSummary(rest)).toBe(true);
  });

  it("accepts null for every genuinely nullable field", () => {
    expect(isTitleSummary(summary({ year: null, rating: null, posterUrl: null }))).toBe(true);
  });

  it("accepts a summary carrying extra unknown fields", () => {
    // Forward compatibility: a NEWER client may store a field this build has
    // never heard of. Rejecting would make a rollback wipe the library.
    expect(isTitleSummary(summary({ somethingNewInPhase9: true }))).toBe(true);
  });

  it("still rejects a WRONG type on an optional field", () => {
    // Absent is survivable; wrong is a bug worth surfacing.
    expect(isTitleSummary(summary({ year: "1972" }))).toBe(false);
    expect(isTitleSummary(summary({ genres: "drama" }))).toBe(false);
    expect(isTitleSummary(summary({ genres: [{ id: "drama" }] }))).toBe(false);
  });
});
