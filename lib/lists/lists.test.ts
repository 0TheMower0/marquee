import { describe, expect, it } from "vitest";

import type { TitleSummary } from "@/lib/content/types";

import { ListError, mapListError } from "./errors";
import type { ListItemEntry, MemberStatus } from "./types";
import {
  LIST_NAME_REJECTION_MESSAGE,
  MAX_LIST_DESCRIPTION_LENGTH,
  MAX_LIST_NAME_LENGTH,
  isListVisibility,
  validateListDescription,
  validateListName,
} from "./validate";
import { computeAgreementItems } from "./wire";

/**
 * `computeAgreementItems` is the whole payoff of this feature — "the feature
 * people actually want on a Friday night" only works if it never reports a
 * false agreement (showing something as watchable-by-everyone when it isn't)
 * and never hides a real one. Both directions get tested, plus the boundary
 * case that makes the function correct without a second "and nobody watched"
 * check: TrackingStatus is mutually exclusive by construction, so
 * status === 'watchlist' for everyone already implies nobody has watched it.
 */

function summaryFor(id: string): TitleSummary {
  return {
    id,
    mediaType: "tv",
    name: `Show ${id}`,
    year: 2020,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function item(titleId: string): ListItemEntry {
  return {
    mediaType: "tv",
    titleId,
    summary: summaryFor(titleId),
    addedBy: null,
    addedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function status(userId: string, titleId: string, statusValue: MemberStatus["status"]): MemberStatus {
  return { userId, mediaType: "tv", titleId, status: statusValue };
}

describe("computeAgreementItems", () => {
  it("includes a title when every member has it watchlisted", () => {
    const items = [item("show1")];
    const members = ["alice", "bob"];
    const statuses = [status("alice", "show1", "watchlist"), status("bob", "show1", "watchlist")];

    expect(computeAgreementItems(items, members, statuses)).toEqual(items);
  });

  it("excludes a title when even ONE member has not watchlisted it", () => {
    const items = [item("show1")];
    const members = ["alice", "bob", "carol"];
    const statuses = [
      status("alice", "show1", "watchlist"),
      status("bob", "show1", "watchlist"),
      // carol has no entry at all for show1
    ];

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });

  it("excludes a title the moment ANY member has watched it", () => {
    // The case the feature exists to filter out.
    const items = [item("show1")];
    const members = ["alice", "bob"];
    const statuses = [status("alice", "show1", "watchlist"), status("bob", "show1", "watched")];

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });

  it("excludes a title where a member is merely 'watching' it, not watchlisted", () => {
    // "Watchlisted by everyone" means status === watchlist specifically —
    // already-in-progress is a different state, not agreement to start.
    const items = [item("show1")];
    const members = ["alice", "bob"];
    const statuses = [status("alice", "show1", "watchlist"), status("bob", "show1", "watching")];

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });

  it("a member with NO tracked_titles row at all does not count as agreement", () => {
    // Absence is not agreement — explicit per the doc comment on the
    // function itself. Regression-guards against a `?? 'watchlist'`-style
    // default ever creeping in.
    const items = [item("show1")];
    const members = ["alice", "bob"];
    const statuses = [status("alice", "show1", "watchlist")]; // bob: nothing

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });

  it("filters a mixed list down to exactly the qualifying items, preserving order", () => {
    const items = [item("show1"), item("show2"), item("show3")];
    const members = ["alice", "bob"];
    const statuses = [
      status("alice", "show1", "watchlist"),
      status("bob", "show1", "watchlist"),
      status("alice", "show2", "watched"), // disqualified
      status("bob", "show2", "watchlist"),
      status("alice", "show3", "watchlist"),
      status("bob", "show3", "watchlist"),
    ];

    expect(computeAgreementItems(items, members, statuses).map((i) => i.titleId)).toEqual([
      "show1",
      "show3",
    ]);
  });

  it("degenerates correctly for a single-member list (no other collaborators yet)", () => {
    const items = [item("show1")];
    const members = ["alice"];
    const statuses = [status("alice", "show1", "watchlist")];

    expect(computeAgreementItems(items, members, statuses)).toEqual(items);
  });

  it("returns nothing when there are no members at all", () => {
    expect(computeAgreementItems([item("show1")], [], [])).toEqual([]);
  });

  it("returns nothing when the list has no items", () => {
    expect(computeAgreementItems([], ["alice", "bob"], [])).toEqual([]);
  });

  it("does not let a status for a DIFFERENT title satisfy agreement on this one", () => {
    // media_type/title_id must match exactly — a member watchlisting the
    // wrong title must not accidentally count.
    const items = [item("show1")];
    const members = ["alice", "bob"];
    const statuses = [
      status("alice", "show1", "watchlist"),
      status("bob", "show-unrelated", "watchlist"),
    ];

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });

  it("does not let a movie satisfy an agreement check for a same-id tv title", () => {
    const items: ListItemEntry[] = [
      { ...item("100"), mediaType: "movie" },
    ];
    const members = ["alice", "bob"];
    const statuses: MemberStatus[] = [
      { userId: "alice", mediaType: "movie", titleId: "100", status: "watchlist" },
      { userId: "bob", mediaType: "tv", titleId: "100", status: "watchlist" }, // wrong media type
    ];

    expect(computeAgreementItems(items, members, statuses)).toEqual([]);
  });
});

describe("validateListName", () => {
  it("accepts and trims an ordinary name", () => {
    expect(validateListName("  Friday Night  ")).toEqual({ ok: true, value: "Friday Night" });
  });

  it("rejects empty/whitespace-only names", () => {
    expect(validateListName("")).toEqual({ ok: false, reason: "empty" });
    expect(validateListName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("enforces the length cap", () => {
    expect(validateListName("a".repeat(MAX_LIST_NAME_LENGTH)).ok).toBe(true);
    expect(validateListName("a".repeat(MAX_LIST_NAME_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("every rejection has user-facing copy", () => {
    for (const reason of ["empty", "too_long"] as const) {
      expect(LIST_NAME_REJECTION_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });
});

describe("validateListDescription", () => {
  it("collapses a blank description to null", () => {
    expect(validateListDescription("")).toEqual({ ok: true, value: null });
    expect(validateListDescription("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts and trims a real description", () => {
    expect(validateListDescription("  movies for date night  ")).toEqual({
      ok: true,
      value: "movies for date night",
    });
  });

  it("enforces its own length cap", () => {
    expect(validateListDescription("a".repeat(MAX_LIST_DESCRIPTION_LENGTH)).ok).toBe(true);
    expect(validateListDescription("a".repeat(MAX_LIST_DESCRIPTION_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("isListVisibility", () => {
  it("accepts exactly the three values the CHECK constraint allows", () => {
    for (const value of ["private", "unlisted", "public"]) {
      expect(isListVisibility(value), value).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isListVisibility("Public")).toBe(false);
    expect(isListVisibility("hidden")).toBe(false);
    expect(isListVisibility("")).toBe(false);
    expect(isListVisibility(null)).toBe(false);
  });
});

describe("mapListError", () => {
  it("maps a 42501 (RLS WITH CHECK rejection) to forbidden", () => {
    expect(mapListError({ code: "42501", message: "policy violation" }).kind).toBe("forbidden");
  });

  it("maps CHECK/NOT NULL violations to invalid_input", () => {
    expect(mapListError({ code: "23514" }).kind).toBe("invalid_input");
    expect(mapListError({ code: "23502" }).kind).toBe("invalid_input");
  });

  it("maps PGRST116 (no rows) to not_found", () => {
    expect(mapListError({ code: "PGRST116" }).kind).toBe("not_found");
  });

  it("recognizes a fetch failure by shape rather than by code", () => {
    expect(mapListError(new TypeError("fetch failed")).kind).toBe("network");
  });

  it("passes a ListError through unchanged", () => {
    const original = new ListError("rate_limited", "x");
    expect(mapListError(original)).toBe(original);
  });

  it("returns unknown rather than guessing at an unrecognized shape", () => {
    expect(mapListError({ code: "99999" }).kind).toBe("unknown");
    expect(mapListError(null).kind).toBe("unknown");
  });
});
