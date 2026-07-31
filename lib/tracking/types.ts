import type { MediaType, Title, TitleSummary } from "@/lib/content/types";

/**
 * Three mutually exclusive states, matching the three sections of My Library.
 * A title has ONE status at a time — "watchlist" and "watched" are not
 * independent flags, so a title cannot be simultaneously on the watchlist and
 * marked watched. Setting a new status always replaces whatever came before.
 */
export type TrackingStatus = "watchlist" | "watching" | "watched";

/**
 * An inclusive run of consecutive watched episode numbers within one season.
 * `[3, 7]` means episodes 3, 4, 5, 6 and 7 are watched.
 *
 * ============================================================================
 * WHY RANGES AND NOT ONE RECORD PER EPISODE
 * ============================================================================
 * A user tracking 30 shows at 8 seasons x ~13 episodes is ~3,120 episodes.
 * Measured, not guessed:
 *
 *   one object per episode (with timestamp)   ~183 KB
 *   array of episode-id strings                ~27 KB
 *   ranges, everything watched                  ~2.8 KB
 *   ranges, pathological alternating gaps      ~11.0 KB
 *
 * Ranges win by ~65x in the realistic case and still by ~17x in a
 * deliberately hostile one, against a localStorage budget of roughly 5 MB
 * shared with everything else on the origin.
 *
 * The reason ranges fit so well is not really compression, it's that they
 * match the shape of the data. Watched state for a show is almost always a
 * contiguous prefix — you watch S1E1 forward. "Mark everything up to here"
 * (the operation people actually use) is *natively* a range write: one
 * range per season, no matter how many episodes it covers. A per-episode
 * model would turn that single user action into hundreds of records.
 *
 * INVARIANT, enforced by `normalizeRanges` in ./ranges.ts: ranges are sorted
 * by start, non-overlapping, and non-adjacent — `[[1,3],[4,6]]` is never
 * stored, it collapses to `[[1,6]]`. Every read and every query assumes this
 * canonical form. Do not construct these by hand; go through ./ranges.ts.
 *
 * WHAT THIS SHAPE DELIBERATELY CANNOT HOLD: a per-episode timestamp. Adding
 * one would make every episode unique and collapse the encoding straight back
 * to ~183 KB. Phase 5 (streaks) and Phase 8 (Year in Review) will want watch
 * *dates*; when they do, that belongs in a separate append-only log keyed by
 * date, not bolted onto this. Progress state and watch history are different
 * concerns with different access patterns, and merging them is exactly what
 * forces the bad shape.
 */
export type EpisodeRange = [start: number, end: number];

/**
 * Watched episodes keyed by season number. **Sparse on purpose** — a season
 * with nothing watched has no key at all, rather than an empty array.
 *
 * Season 0 is a legitimate key: TMDB uses it for "Specials", and the mock
 * catalog has one (Twin Peaks). Anything iterating seasons must not assume
 * `1..seasonCount`.
 *
 * Typed `Record<number, …>` for ergonomics, but note JSON object keys are
 * always strings — after a storage round trip this is really
 * `{"1": [[1,13]]}`. `obj[1]` and `obj["1"]` are the same property at
 * runtime so reads are fine, but `Object.keys()` yields strings and needs
 * `Number(k)` before use.
 */
export type WatchedEpisodes = Record<number, EpisodeRange[]>;

interface TrackingEntryBase {
  id: string;
  /**
   * Coarse status for the title as a whole. For TV this now coexists with
   * per-episode detail, and the two are different *granularities of the same
   * fact*, not competing sources of truth:
   *
   *   - `status` always exists, for both media types.
   *   - `watchedEpisodes` refines it for TV, when present.
   *
   * Queries prefer the fine-grained ranges and fall back to `status` when a
   * show has none. That fallback is what makes the v1 -> v2 migration
   * lossless — see the migration note in ./store.ts.
   */
  status: TrackingStatus;
  addedAt: Date;
  updatedAt: Date;
  /**
   * A snapshot of the title at the moment it was tracked, not a live
   * reference. My Library renders directly from this — re-fetching every
   * tracked title from the provider on every Library visit would be N calls
   * for one page. Tradeoff: the poster/rating shown here can go stale if the
   * source data changes later. Acceptable for Phase 2; the title detail page
   * always shows a freshly fetched `Title` regardless of what's cached here.
   */
  summary: TitleSummary;
}

/**
 * Movies keep the v1 shape plus one addition (Phase 5 Step 2): `runtimeMinutes`,
 * captured from the full `Title` at the moment `setStatus` is called — see the
 * `hint` parameter in context.tsx. `summary` (a `TitleSummary`) deliberately
 * has no runtime field of its own, so this is the one place a movie entry
 * knows its own length. It exists SOLELY so lib/xp can scale XP by runtime
 * without a provider fetch at Profile-render time; nothing else should read
 * it. `null` on records written before this field existed, or when the hint
 * was unavailable — an honest gap, not a fabricated runtime. lib/xp falls
 * back to a flat default in that case.
 */
export interface MovieTrackingEntry extends TrackingEntryBase {
  mediaType: "movie";
  runtimeMinutes: number | null;
}

/**
 * `knownEpisodeCount` (Phase 5 Step 2) is an XP-only fallback, captured the
 * same way as `runtimeMinutes` above. It exists for exactly one situation:
 * a show marked "watched" through the coarse status button, where
 * `watchedEpisodes` is empty and there is no other way to know how many
 * episodes to award XP for. Anywhere `watchedEpisodes` has real ranges,
 * `countRanges` is exact and this field is ignored — it is NOT a cache of
 * season structure and must never be used for progress math. That
 * distinction matters: CLAUDE.md is explicit that season structure is
 * deliberately not stored on the entry, and this field does not violate that
 * — it is a single scalar snapshot for one XP edge case, not season data.
 */
export interface TvTrackingEntry extends TrackingEntryBase {
  mediaType: "tv";
  watchedEpisodes: WatchedEpisodes;
  knownEpisodeCount: number | null;
}

/**
 * Discriminated on `mediaType`, so `watchedEpisodes` is only reachable after
 * narrowing to TV. A movie entry cannot carry episode progress even by
 * accident, and TypeScript enforces it at every call site rather than relying
 * on a convention.
 */
export type TrackingEntry = MovieTrackingEntry | TvTrackingEntry;

/**
 * Season structure is NOT stored on the entry, and that is deliberate.
 *
 * Totals ("12 of 62 watched", "3 episodes remaining") need to know how many
 * episodes exist, which is provider data, not user data. Caching it here
 * would be stored derived state that goes stale the moment a returning show
 * airs another episode — precisely the failure mode this schema is trying to
 * avoid. Queries therefore take the season list as an argument, fetched via
 * `getSeasons()`.
 *
 * Open question deferred to Step 2 (the Up Next engine), where the real
 * access pattern will be visible: My Library showing "N remaining" per card
 * would need a `getSeasons()` call per tracked show. If that turns out to be
 * the dominant cost, the answer is a short-lived cache in the *content*
 * layer, not a denormalized copy in the *tracking* record.
 */
export type SeasonEpisodeCounts = ReadonlyArray<{
  seasonNumber: number;
  episodeCount: number;
}>;

/**
 * Explicit allowlist, matching the pattern `mock/index.ts`'s `toSummary()`
 * already established for the same reason: never spread-and-omit `Title`, or
 * a field added to it later (cast, backdropUrl, ...) leaks into every stored
 * snapshot without anyone deciding it should.
 */
export function toTrackingSummary(title: Title): TitleSummary {
  return {
    id: title.id,
    mediaType: title.mediaType,
    name: title.name,
    year: title.year,
    overview: title.overview,
    genres: title.genres,
    posterUrl: title.posterUrl,
    placeholder: title.placeholder,
    rating: title.rating,
  };
}

export function entryKey(mediaType: MediaType, id: string): string {
  return `${mediaType}:${id}`;
}
