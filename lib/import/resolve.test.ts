import { describe, expect, it, vi } from "vitest";

import type { MediaType, PagedResult, TitleSummary } from "@/lib/content/types";

import { dedupKey, lookupCount, resolveRows, type ResolveDeps } from "./resolve";
import type { ImportRow } from "./types";

function title(
  id: string,
  name: string,
  year: number | null,
  mediaType: MediaType = "movie",
): TitleSummary {
  return {
    id,
    mediaType,
    name,
    year,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function page(items: TitleSummary[]): PagedResult<TitleSummary> {
  return { items, page: 1, totalPages: 1, totalResults: items.length };
}

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    source: "letterboxd-diary",
    sourceRowId: `letterboxd-diary:${overrides.sourceLine ?? 2}`,
    imdbId: null,
    title: "Gravity",
    originalTitle: null,
    year: 2013,
    slug: null,
    mediaTypeHint: "movie",
    score: null,
    ratedOn: null,
    watchedOn: null,
    isRewatch: false,
    intent: "watched",
    sourceLine: 2,
    ...overrides,
  };
}

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    findByExternalId: async () => [],
    searchTitles: async () => page([]),
    ...overrides,
  };
}

describe("dedupKey", () => {
  it("prefers an IMDb id over everything else", () => {
    expect(dedupKey(row({ imdbId: "tt1454468", slug: "gravity-2013" }))).toBe("imdb:tt1454468");
  });

  it("falls back to the slug, then to normalized title+year", () => {
    expect(dedupKey(row({ slug: "gravity-2013" }))).toBe("slug:gravity-2013");
    expect(dedupKey(row({ title: "The Gravity", year: 2013 }))).toBe("title:gravity:2013");
  });

  it("groups rows differing only in case or article", () => {
    expect(dedupKey(row({ title: "the GRAVITY" }))).toBe(dedupKey(row({ title: "Gravity" })));
  });

  it("does NOT group two different years", () => {
    expect(dedupKey(row({ year: 2013 }))).not.toBe(dedupKey(row({ year: 1984 })));
  });

  it("records a missing year rather than treating it as a wildcard", () => {
    expect(dedupKey(row({ year: null }))).toBe("title:gravity:?");
  });
});

describe("resolveRows — deduplication", () => {
  it("performs ONE lookup for a film watched several times", async () => {
    // The main upstream saving: a Letterboxd diary holds one row per viewing.
    const searchTitles = vi.fn(async () => page([title("a", "Heat", 1995)]));
    const rows = [
      row({ title: "Heat", year: 1995, sourceLine: 2, watchedOn: "2020-01-01" }),
      row({ title: "Heat", year: 1995, sourceLine: 3, watchedOn: "2021-06-01" }),
      row({ title: "Heat", year: 1995, sourceLine: 4, watchedOn: "2022-02-02" }),
    ];

    const resolved = await resolveRows(rows, deps({ searchTitles }));

    expect(searchTitles).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(3);
    expect(resolved.every((r) => r.chosen?.id === "a")).toBe(true);
  });

  it("keeps each row's OWN data alongside the shared match", async () => {
    // The group supplies the match; the row supplies its date, rating and
    // line number. Losing the latter would collapse three viewings into one.
    const rows = [
      row({ title: "Heat", sourceLine: 2, watchedOn: "2020-01-01" }),
      row({ title: "Heat", sourceLine: 3, watchedOn: "2021-06-01" }),
    ];
    const resolved = await resolveRows(
      rows,
      deps({ searchTitles: async () => page([title("a", "Heat", 2013)]) }),
    );

    expect(resolved.map((r) => r.row.watchedOn)).toEqual(["2020-01-01", "2021-06-01"]);
    expect(resolved.map((r) => r.row.sourceLine)).toEqual([2, 3]);
  });

  it("returns rows in their ORIGINAL order, not group order", async () => {
    const rows = [
      row({ title: "Alpha", sourceLine: 2 }),
      row({ title: "Beta", sourceLine: 3 }),
      row({ title: "Alpha", sourceLine: 4 }),
    ];
    const resolved = await resolveRows(rows, deps());
    expect(resolved.map((r) => r.row.sourceLine)).toEqual([2, 3, 4]);
  });

  it("reports the true upstream cost before doing any work", () => {
    const rows = [
      row({ title: "Heat", sourceLine: 2 }),
      row({ title: "Heat", sourceLine: 3 }),
      row({ title: "Alien", sourceLine: 4 }),
      row({ mediaTypeHint: "episode", title: "Ozymandias", sourceLine: 5 }),
    ];
    expect(lookupCount(rows)).toBe(2);
  });
});

describe("resolveRows — tier order", () => {
  it("uses the external id and never searches when it resolves uniquely", async () => {
    const searchTitles = vi.fn(async () => page([]));
    const resolved = await resolveRows(
      [row({ imdbId: "tt1454468" })],
      deps({ findByExternalId: async () => [title("49047", "Gravity", 2013)], searchTitles }),
    );

    expect(resolved[0].bucket).toBe("exact");
    expect(searchTitles).not.toHaveBeenCalled();
  });

  it("FALLS THROUGH to title search when the id is unknown upstream", async () => {
    // TMDB genuinely lacks external-id mappings for some titles it carries.
    // Giving up at tier 1 would send a resolvable row to the review queue.
    const searchTitles = vi.fn(async () => page([title("a", "Gravity", 2013)]));
    const resolved = await resolveRows(
      [row({ imdbId: "tt1454468" })],
      deps({ findByExternalId: async () => [], searchTitles }),
    );

    expect(searchTitles).toHaveBeenCalledTimes(1);
    expect(resolved[0].bucket).toBe("confident");
  });

  it("does NOT fall through when the id is genuinely ambiguous", async () => {
    // A title search cannot resolve an id collision; running one would swap a
    // known-ambiguous answer for a differently-ambiguous one.
    const searchTitles = vi.fn(async () => page([title("z", "Gravity", 2013)]));
    const resolved = await resolveRows(
      [row({ imdbId: "tt1454468" })],
      deps({
        findByExternalId: async () => [title("a", "Gravity", 2013), title("b", "Gravity", 2013)],
        searchTitles,
      }),
    );

    expect(searchTitles).not.toHaveBeenCalled();
    expect(resolved[0].bucket).toBe("ambiguous");
    expect(resolved[0].chosen).toBeNull();
  });

  it("spends no lookup at all on an unsupported row", async () => {
    const findByExternalId = vi.fn(async () => []);
    const searchTitles = vi.fn(async () => page([]));
    const resolved = await resolveRows(
      [row({ mediaTypeHint: "episode", imdbId: "tt2301451" })],
      deps({ findByExternalId, searchTitles }),
    );

    expect(findByExternalId).not.toHaveBeenCalled();
    expect(searchTitles).not.toHaveBeenCalled();
    expect(resolved[0].bucket).toBe("unsupported");
  });

  it("searches the original title when the primary one is blank", async () => {
    const searchTitles = vi.fn(async () => page([title("a", "Der Untergang", 2004)]));
    await resolveRows(
      [row({ title: "", originalTitle: "Der Untergang", year: 2004 })],
      deps({ searchTitles }),
    );
    expect(searchTitles).toHaveBeenCalledWith("Der Untergang");
  });
});

describe("resolveRows — failure isolation", () => {
  it("turns ONE row's upstream failure into an unmatched row, not a failed import", async () => {
    let call = 0;
    const searchTitles = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("upstream exploded");
      return page([title("a", "Fine", 2000)]);
    });

    const resolved = await resolveRows(
      [
        row({ title: "First", year: 2000, sourceLine: 2 }),
        row({ title: "Second", year: 2000, sourceLine: 3 }),
        row({ title: "Third", year: 2000, sourceLine: 4 }),
      ],
      deps({ searchTitles }),
      { concurrency: 1 },
    );

    expect(resolved).toHaveLength(3);
    expect(resolved[1].bucket).toBe("unmatched");
    // The row is visibly present for the user to resolve by hand, rather than
    // silently missing from the results.
    expect(resolved[1].row.sourceLine).toBe(3);
  });

  it("marks a row unmatched when the search returns nothing", async () => {
    const resolved = await resolveRows([row()], deps());
    expect(resolved[0].bucket).toBe("unmatched");
    expect(resolved[0].candidates).toEqual([]);
  });
});

describe("resolveRows — concurrency", () => {
  it("never exceeds the configured number of in-flight requests", async () => {
    let inFlight = 0;
    let peak = 0;
    const searchTitles = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return page([]);
    });

    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ title: `Film ${i}`, sourceLine: i + 2 }),
    );
    await resolveRows(rows, deps({ searchTitles }), { concurrency: 3 });

    expect(searchTitles).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("resolves every row even when there are more rows than workers", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ title: `F${i}`, sourceLine: i + 2 }));
    const resolved = await resolveRows(
      rows,
      deps({ searchTitles: async () => page([title("x", "F", 2000)]) }),
      { concurrency: 2 },
    );
    expect(resolved).toHaveLength(9);
    expect(resolved.every((r) => r.row.title.startsWith("F"))).toBe(true);
  });
});
