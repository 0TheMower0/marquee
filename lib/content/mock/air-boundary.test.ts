import { describe, expect, it } from "vitest";

import { isFutureAirDate } from "@/lib/utils/dates";

import { mockProvider } from "./index";

/**
 * `lastEpisodeToAir` / `nextEpisodeToAir` are DERIVED in mockProvider
 * (`airBoundaryFor`) but arrive inline from TMDB in tmdbProvider. Only the
 * derived side can be wrong in a way nothing else would notice, so it is the
 * side worth pinning.
 *
 * These assert the CONTRACT rather than specific episode numbers on purpose:
 * the mock catalog's air dates are relative to the real clock (The Bear
 * deliberately carries a future-dated episode), so hardcoding "S4E3" would
 * start failing on a date rather than on a code change.
 */

describe("mockProvider air boundary", () => {
  it("returns null for both on a movie — these are TV-only fields", async () => {
    const movie = await mockProvider.getTitle("the-godfather", "movie");
    expect(movie.lastEpisodeToAir).toBeNull();
    expect(movie.nextEpisodeToAir).toBeNull();
  });

  it("never reports an unaired episode as the last aired one", async () => {
    // The invariant that actually matters: notifying about `lastEpisodeToAir`
    // is the whole feature, so this field claiming a future episode would
    // send "S6E1 aired!" before it had.
    for (const id of ["breaking-bad", "the-bear", "stranger-things"]) {
      const title = await mockProvider.getTitle(id, "tv");
      if (title.lastEpisodeToAir) {
        expect(
          isFutureAirDate(title.lastEpisodeToAir.airDate),
          `${id} reported an unaired episode as lastEpisodeToAir`,
        ).toBe(false);
      }
    }
  });

  it("never reports an already-aired episode as the next one", async () => {
    for (const id of ["breaking-bad", "the-bear", "stranger-things"]) {
      const title = await mockProvider.getTitle(id, "tv");
      if (title.nextEpisodeToAir) {
        expect(
          isFutureAirDate(title.nextEpisodeToAir.airDate),
          `${id} reported an aired episode as nextEpisodeToAir`,
        ).toBe(true);
      }
    }
  });

  it("finds a next episode for a currently-airing show", async () => {
    // The Bear is the mock catalog's deliberate "currently airing" fixture —
    // it carries an episode dated after today specifically so this state is
    // reachable offline. If this ever returns null, either that fixture's
    // date has fallen into the past or the scan is broken.
    const bear = await mockProvider.getTitle("the-bear", "tv");
    expect(bear.nextEpisodeToAir).not.toBeNull();
    expect(bear.lastEpisodeToAir).not.toBeNull();
  });

  it("reports no next episode for a show that has fully ended", async () => {
    const bb = await mockProvider.getTitle("breaking-bad", "tv");
    expect(bb.nextEpisodeToAir).toBeNull();
    expect(bb.lastEpisodeToAir).not.toBeNull();
  });

  it("excludes season 0 — a special airing is not 'a new episode'", async () => {
    // Twin Peaks is the catalog's Season-0 fixture. Whatever the boundary
    // resolves to, it must never be a specials episode: lib/tracking already
    // excludes season 0 from completion math, and a notification saying "new
    // episode" for a retrospective would be wrong in the same way.
    const twinPeaks = await mockProvider.getTitle("twin-peaks", "tv");
    expect(twinPeaks.lastEpisodeToAir?.seasonNumber ?? 1).toBeGreaterThanOrEqual(1);
    expect(twinPeaks.nextEpisodeToAir?.seasonNumber ?? 1).toBeGreaterThanOrEqual(1);
  });
});
