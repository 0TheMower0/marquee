"use client";

import { useEffect, useState } from "react";

import {
  addRange,
  countRanges,
  expandRanges,
  normalizeRanges,
  rangesContain,
  removeRange,
} from "@/lib/tracking/ranges";
import { normalizeWatchedEpisodes, trackingStore } from "@/lib/tracking/store";
import type { EpisodeRange } from "@/lib/tracking/types";

/** TEMPORARY — Phase 3 Step 1 schema/migration verification. Delete after review. */

type Result = { name: string; pass: boolean; detail: string };

function check(r: Result[], name: string, pass: boolean, detail = "") {
  r.push({ name, pass, detail });
}

const KEY = (k: string) => `marquee:tracking:${k}`;
const DATE = (iso: string) => ({ __mq_date: iso });

/** A v1 record exactly as Phase 2 Step 3 would have written it. */
function v1Record(
  id: string,
  mediaType: "movie" | "tv",
  status: string,
): string {
  return JSON.stringify({
    v: 1,
    d: {
      id,
      mediaType,
      status,
      addedAt: DATE("2026-01-15T10:00:00.000Z"),
      updatedAt: DATE("2026-02-20T18:30:00.000Z"),
      summary: {
        id,
        mediaType,
        name: `Fixture ${id}`,
        year: 2020,
        overview: "planted v1 fixture",
        genres: [{ id: "drama", name: "Drama" }],
        posterUrl: null,
        placeholder: { gradientFrom: "#111", gradientTo: "#222" },
        rating: 8,
      },
    },
  });
}

async function run(): Promise<Result[]> {
  const r: Result[] = [];
  window.localStorage.clear();

  // ---- Range primitives (the encoding's own invariant) -------------------
  check(
    r,
    "normalize merges ADJACENT ranges (1-3 + 4-6 => 1-6)",
    JSON.stringify(normalizeRanges([[1, 3], [4, 6]])) === "[[1,6]]",
    JSON.stringify(normalizeRanges([[1, 3], [4, 6]])),
  );
  check(
    r,
    "normalize merges overlapping and sorts unsorted input",
    JSON.stringify(normalizeRanges([[5, 9], [1, 6]])) === "[[1,9]]",
    JSON.stringify(normalizeRanges([[5, 9], [1, 6]])),
  );
  check(
    r,
    "normalize drops malformed ranges",
    JSON.stringify(
      normalizeRanges([
        [3, 1],
        [1, 2],
        // deliberately wrong shapes that could come off disk
        ...([[1], "x", null, [1.5, 2]] as unknown as EpisodeRange[]),
      ]),
    ) === "[[1,2]]",
  );
  check(
    r,
    "marking episodes one at a time collapses to ONE range",
    JSON.stringify(
      [1, 2, 3, 4, 5, 6, 7, 8].reduce<EpisodeRange[]>(
        (acc, n) => addRange(acc, [n, n]),
        [],
      ),
    ) === "[[1,8]]",
  );
  check(
    r,
    "removing a middle episode splits the range",
    JSON.stringify(removeRange([[1, 10]], [5, 5])) === "[[1,4],[6,10]]",
    JSON.stringify(removeRange([[1, 10]], [5, 5])),
  );
  check(
    r,
    "rangesContain / countRanges agree with expansion",
    rangesContain([[1, 4], [6, 10]], 7) &&
      !rangesContain([[1, 4], [6, 10]], 5) &&
      countRanges([[1, 4], [6, 10]]) === 9 &&
      expandRanges([[1, 4], [6, 10]]).length === 9,
  );
  check(
    r,
    "season 0 (Specials) survives normalization",
    JSON.stringify(normalizeWatchedEpisodes({ 0: [[1, 2]] })) ===
      '{"0":[[1,2]]}',
    JSON.stringify(normalizeWatchedEpisodes({ 0: [[1, 2]] })),
  );
  check(
    r,
    "normalizeWatchedEpisodes stays sparse (empty season key dropped)",
    JSON.stringify(normalizeWatchedEpisodes({ 3: [] })) === "{}",
  );

  // ---- v1 -> v2 migration on planted records ----------------------------
  window.localStorage.setItem(
    KEY("movie:planted-movie"),
    v1Record("planted-movie", "movie", "watched"),
  );
  window.localStorage.setItem(
    KEY("tv:planted-watched"),
    v1Record("planted-watched", "tv", "watched"),
  );
  window.localStorage.setItem(
    KEY("tv:planted-watchlist"),
    v1Record("planted-watchlist", "tv", "watchlist"),
  );

  const movie = await trackingStore.get("movie:planted-movie");
  check(
    r,
    "v1 movie migrates and keeps its status",
    movie?.mediaType === "movie" && movie.status === "watched",
    JSON.stringify(movie?.status),
  );
  check(
    r,
    "v1 movie gains NO watchedEpisodes field",
    movie !== null && !("watchedEpisodes" in movie),
  );

  const tvWatched = await trackingStore.get("tv:planted-watched");
  check(
    r,
    "v1 TV gains watchedEpisodes",
    tvWatched?.mediaType === "tv" &&
      JSON.stringify(tvWatched.watchedEpisodes) === "{}",
    JSON.stringify(
      tvWatched?.mediaType === "tv" ? tvWatched.watchedEpisodes : undefined,
    ),
  );
  check(
    r,
    "v1 TV 'watched' status is PRESERVED (no information lost)",
    tvWatched?.status === "watched",
    JSON.stringify(tvWatched?.status),
  );
  check(
    r,
    "Dates survive the migration as real Date objects",
    tvWatched?.addedAt instanceof Date &&
      tvWatched.addedAt.toISOString() === "2026-01-15T10:00:00.000Z" &&
      tvWatched.updatedAt instanceof Date,
    String(tvWatched?.addedAt),
  );
  check(
    r,
    "summary snapshot survives the migration intact",
    tvWatched?.summary?.name === "Fixture planted-watched",
    String(tvWatched?.summary?.name),
  );

  const tvWatchlist = await trackingStore.get("tv:planted-watchlist");
  check(
    r,
    "v1 TV on watchlist migrates too",
    tvWatchlist?.mediaType === "tv" && tvWatchlist.status === "watchlist",
  );

  // ---- Write-back: migration paid once, not on every read ---------------
  await new Promise((resolve) => setTimeout(resolve, 60));
  const persisted = JSON.parse(
    window.localStorage.getItem(KEY("tv:planted-watched")) ?? "{}",
  );
  check(
    r,
    "migrated record is written back at v2",
    persisted.v === 2 && JSON.stringify(persisted.d?.watchedEpisodes) === "{}",
    JSON.stringify(persisted).slice(0, 120),
  );

  // ---- A malformed v1 record must be skipped, NOT destroyed --------------
  const junk = JSON.stringify({ v: 1, d: "not an object" });
  window.localStorage.setItem(KEY("tv:planted-junk"), junk);
  const junkRead = await trackingStore.get("tv:planted-junk");
  check(r, "malformed v1 record reads as null", junkRead === null);
  check(
    r,
    "malformed v1 record is LEFT ON DISK (no data loss)",
    window.localStorage.getItem(KEY("tv:planted-junk")) === junk,
  );

  // ---- Rollback safety still holds at v2 --------------------------------
  const future = JSON.stringify({ v: 99, d: { fancy: true } });
  window.localStorage.setItem(KEY("tv:planted-future"), future);
  check(
    r,
    "record from a newer schema reads as null",
    (await trackingStore.get("tv:planted-future")) === null,
  );
  check(
    r,
    "record from a newer schema is left intact",
    window.localStorage.getItem(KEY("tv:planted-future")) === future,
  );

  // ---- A v2 record with episode data round-trips ------------------------
  await trackingStore.set("tv:round-trip", {
    id: "round-trip",
    mediaType: "tv",
    status: "watching",
    addedAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    summary: {
      id: "round-trip",
      mediaType: "tv",
      name: "Round Trip",
      year: 2021,
      overview: "",
      genres: [],
      posterUrl: null,
      placeholder: { gradientFrom: "#000", gradientTo: "#fff" },
      rating: null,
    },
    watchedEpisodes: { 0: [[1, 2]], 1: [[1, 13]], 2: [[1, 4], [6, 6]] },
  });
  const back = await trackingStore.get("tv:round-trip");
  check(
    r,
    "v2 episode ranges round-trip through storage",
    back?.mediaType === "tv" &&
      JSON.stringify(back.watchedEpisodes) ===
        '{"0":[[1,2]],"1":[[1,13]],"2":[[1,4],[6,6]]}',
    JSON.stringify(
      back?.mediaType === "tv" ? back.watchedEpisodes : undefined,
    ),
  );

  // ---- Size check on a realistic library --------------------------------
  const before = new Blob([JSON.stringify(window.localStorage)]).size;
  for (let show = 0; show < 30; show += 1) {
    const watchedEpisodes: Record<number, EpisodeRange[]> = {};
    for (let s = 1; s <= 8; s += 1) watchedEpisodes[s] = [[1, 13]];
    await trackingStore.set(`tv:size-${show}`, {
      id: `size-${show}`,
      mediaType: "tv",
      status: "watched",
      addedAt: new Date(),
      updatedAt: new Date(),
      summary: {
        id: `size-${show}`,
        mediaType: "tv",
        name: `Size Test ${show}`,
        year: 2020,
        overview: "x".repeat(120),
        genres: [{ id: "drama", name: "Drama" }],
        posterUrl: null,
        placeholder: { gradientFrom: "#111", gradientTo: "#222" },
        rating: 8,
      },
      watchedEpisodes,
    });
  }
  const after = new Blob([JSON.stringify(window.localStorage)]).size;
  const kb = (after - before) / 1024;
  check(
    r,
    "30 shows x 8 seasons x 13 eps fully watched stays small",
    kb < 40,
    `${kb.toFixed(1)} KB total (incl. summary snapshots), vs ~183 KB for episode data alone under a per-episode model`,
  );

  window.localStorage.clear();
  return r;
}

export function Runner() {
  const [output, setOutput] = useState("running…");

  useEffect(() => {
    run()
      .then((results) => {
        const failed = results.filter((x) => !x.pass);
        const text = [
          `${results.length - failed.length}/${results.length} passed`,
          "",
          ...results.map(
            (x) =>
              `${x.pass ? "PASS" : "FAIL"}  ${x.name}${x.detail ? `  — ${x.detail}` : ""}`,
          ),
        ].join("\n");
        (window as unknown as Record<string, unknown>).__migrationTest = {
          total: results.length,
          failed: failed.length,
          text,
        };
        setOutput(text);
      })
      .catch((e) => {
        (window as unknown as Record<string, unknown>).__migrationTest = {
          harnessError: String(e),
        };
        setOutput(`HARNESS ERROR: ${String(e)}`);
      });
  }, []);

  return <pre className="text-body-sm whitespace-pre-wrap">{output}</pre>;
}
