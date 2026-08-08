import { describe, expect, it } from "vitest";

import type { MediaType, TitleSummary } from "@/lib/content/types";

import { classifyRanked, resolveByExternalId, resolveByTitle } from "./classify";
import { diceCoefficient, normalizeTitle, rankCandidates, tokenize } from "./normalize";
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

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    source: "letterboxd-diary",
    sourceRowId: "letterboxd-diary:2",
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

describe("normalizeTitle", () => {
  it("is case- and punctuation-insensitive", () => {
    expect(normalizeTitle("The Godfather!")).toBe(normalizeTitle("the godfather"));
  });

  it("strips leading articles in several languages", () => {
    expect(normalizeTitle("The Matrix")).toBe("matrix");
    expect(normalizeTitle("La Haine")).toBe("haine");
    expect(normalizeTitle("Der Untergang")).toBe("untergang");
  });

  it("handles IMDb's trailing-article form, including before a subtitle", () => {
    // "Godfather, The: Part II" must converge with TMDB's
    // "The Godfather Part II" or every such title scores as a partial match
    // against its own exact counterpart.
    expect(normalizeTitle("Godfather, The: Part II")).toBe(
      normalizeTitle("The Godfather Part II"),
    );
    expect(normalizeTitle("Matrix, The")).toBe(normalizeTitle("The Matrix"));
  });

  it("strips diacritics", () => {
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(normalizeTitle("Le Fabuleux Destin d'Amélie Poulain")).toContain("amelie");
  });

  it("strips a trailing parenthesized year", () => {
    expect(normalizeTitle("Gravity (2013)")).toBe("gravity");
  });

  it("converges ampersand and 'and'", () => {
    expect(normalizeTitle("Fire & Blood")).toBe(normalizeTitle("Fire and Blood"));
  });

  it("DOES collapse titles differing only by a leading article — accepted, and contained", () => {
    // "Heat" (1995) and "The Heat" (2013) are different films that normalize
    // identically. That is the deliberate cost of article stripping, which
    // pays for itself on the far more common IMDb-vs-TMDB "Godfather, The"
    // case above.
    //
    // It is safe because normalization alone never auto-imports anything: the
    // `confident` bucket also requires an exact year agreement, and two films
    // differing only by an article AND sharing a release year is a case
    // neither of us could name an example of. The test below pins the
    // containment rather than the collision.
    expect(normalizeTitle("Heat")).toBe(normalizeTitle("The Heat"));
  });
});

describe("tokenize", () => {
  it("folds pure roman numerals to digits", () => {
    expect(tokenize(normalizeTitle("The Godfather Part II"))).toEqual(
      tokenize(normalizeTitle("The Godfather Part 2")),
    );
    expect(tokenize(normalizeTitle("Rocky IV"))).toEqual(tokenize(normalizeTitle("Rocky 4")));
  });
});

describe("diceCoefficient", () => {
  it("is 1 for identical sets and 0 for disjoint ones", () => {
    expect(diceCoefficient(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(diceCoefficient(new Set(["a"]), new Set(["z"]))).toBe(0);
  });

  it("is forgiving of one extra subtitle word", () => {
    expect(
      diceCoefficient(new Set(["blade", "runner"]), new Set(["blade", "runner", "2049"])),
    ).toBeGreaterThan(0.7);
  });
});

describe("rankCandidates", () => {
  it("ranks an exact title+year match above a more popular wrong-year one", () => {
    // TMDB returns candidates in ITS popularity order; the 2021 Dune would
    // come first. Ours must not.
    const ranked = rankCandidates(row({ title: "Dune", year: 1984 }), [
      title("841", "Dune", 2021),
      title("438", "Dune", 1984),
    ]);
    expect(ranked[0].summary.id).toBe("438");
  });

  it("preserves provider order only as a tiebreak between equal scores", () => {
    const ranked = rankCandidates(row({ title: "Gravity", year: 2013 }), [
      title("first", "Gravity", 2013),
      title("second", "Gravity", 2013),
    ]);
    expect(ranked.map((c) => c.summary.id)).toEqual(["first", "second"]);
  });

  it("sinks a candidate of the wrong media type", () => {
    const ranked = rankCandidates(row({ title: "Fargo", year: 1996, mediaTypeHint: "movie" }), [
      title("tv", "Fargo", 1996, "tv"),
      title("film", "Fargo", 1996, "movie"),
    ]);
    expect(ranked[0].summary.id).toBe("film");
  });

  it("uses originalTitle when the primary title does not match", () => {
    const ranked = rankCandidates(
      row({ title: "The Rise of Evil", originalTitle: "Der Untergang", year: 2004 }),
      [title("x", "Der Untergang", 2004)],
    );
    expect(ranked[0].signals.titleIdentical).toBe(true);
  });

  it("uses a Letterboxd slug as a fallback title signal", () => {
    const ranked = rankCandidates(
      row({ title: "", slug: "gravity-2013", year: 2013 }),
      [title("x", "Gravity", 2013)],
    );
    expect(ranked[0].signals.titleIdentical).toBe(true);
  });

  it("explains every candidate in plain language", () => {
    const ranked = rankCandidates(row({ title: "Gravity", year: 2013 }), [
      title("a", "Gravity", 2013),
      title("b", "Gravity", 2010),
    ]);
    expect(ranked[0].reason).toBe("title matches exactly, year matches");
    expect(ranked[1].reason).toBe("title matches exactly, year differs by 3");
  });
});

describe("the scorer cannot promote a candidate into `confident`", () => {
  /**
   * `agreesExactly` reads SIGNALS, never the score — so retuning the point
   * weights cannot, by construction, change which candidates are eligible to
   * auto-import. What the weights CAN do is change which candidate lands at
   * position 0, and `classifyRanked` only inspects the top two.
   *
   * That is safe only while every exactly-agreeing candidate outranks every
   * non-agreeing one. The margin is currently 90 vs 85 — five points — and it
   * is not obvious from reading the weights. These tests pin it, so a future
   * retune (bumping `titleDiceMax` to 55 would do it) fails here loudly
   * rather than quietly letting a near-miss reach the top slot.
   */
  it("floor of an exactly-agreeing candidate beats the ceiling of any other", () => {
    const noHint = row({ title: "Solaris", year: 1972, mediaTypeHint: "unknown" });

    // Weakest possible exact agreement: identical title, exact year, and a
    // hint too vague to earn the type bonus.
    const [weakestAgreeing] = rankCandidates(noHint, [title("a", "Solaris", 1972)]);

    // Strongest possible non-agreements, one per way of failing the predicate.
    const [wrongYear] = rankCandidates(
      row({ title: "Solaris", year: 1972, mediaTypeHint: "movie" }),
      [title("b", "Solaris", 1973)],
    );
    const [nearTitle] = rankCandidates(
      row({ title: "Solaris", year: 1972, mediaTypeHint: "movie" }),
      [title("c", "Solaris Rising", 1972)],
    );

    expect(weakestAgreeing.score).toBeGreaterThan(wrongYear.score);
    expect(weakestAgreeing.score).toBeGreaterThan(nearTitle.score);
  });

  it("puts the exactly-agreeing candidate first even when listed last", () => {
    const ranked = rankCandidates(
      row({ title: "Solaris", year: 1972, mediaTypeHint: "unknown" }),
      [
        title("near", "Solaris Rising", 1972),
        title("wrong-year", "Solaris", 2002),
        title("right", "Solaris", 1972),
      ],
    );
    expect(ranked[0].summary.id).toBe("right");
  });
});

describe("classifyRanked — the rule that must not erode", () => {
  const gravity = row({ title: "Gravity", year: 2013 });

  it("is confident for a unique exact title+year match", () => {
    const ranked = rankCandidates(gravity, [title("a", "Gravity", 2013)]);
    expect(classifyRanked(gravity, ranked)).toBe("confident");
  });

  it("is confident when the runner-up is clearly worse", () => {
    const ranked = rankCandidates(gravity, [
      title("a", "Gravity", 2013),
      title("b", "Gravity Falls", 2012, "tv"),
    ]);
    expect(classifyRanked(gravity, ranked)).toBe("confident");
  });

  it("is AMBIGUOUS when two candidates agree exactly — a remake", () => {
    // The headline anti-footgun. No popularity tiebreak is permitted here.
    const ranked = rankCandidates(gravity, [
      title("a", "Gravity", 2013),
      title("b", "Gravity", 2013),
    ]);
    expect(classifyRanked(gravity, ranked)).toBe("ambiguous");
  });

  it("is ambiguous when the year is off by even one", () => {
    // Festival-vs-release-year discrepancies are real, so this stays a
    // candidate — but it is not something to commit unasked.
    const ranked = rankCandidates(gravity, [title("a", "Gravity", 2014)]);
    expect(classifyRanked(gravity, ranked)).toBe("ambiguous");
  });

  it("is ambiguous when the ROW has no year, however perfect the title", () => {
    const noYear = row({ title: "Dune", year: null });
    const ranked = rankCandidates(noYear, [title("a", "Dune", 2021)]);
    expect(classifyRanked(noYear, ranked)).toBe("ambiguous");
  });

  it("is ambiguous when the CANDIDATE has no year", () => {
    const ranked = rankCandidates(gravity, [title("a", "Gravity", null)]);
    expect(classifyRanked(gravity, ranked)).toBe("ambiguous");
  });

  it("is ambiguous for a near-miss title even with a matching year", () => {
    const ranked = rankCandidates(gravity, [title("a", "Gravity Falls", 2013)]);
    expect(classifyRanked(gravity, ranked)).toBe("ambiguous");
  });

  it("is unmatched with no candidates", () => {
    expect(classifyRanked(gravity, [])).toBe("unmatched");
  });

  it("does not auto-import an article-only title collision — the year contains it", () => {
    // The containment for the deliberate "Heat" / "The Heat" normalization
    // collision noted in the normalizeTitle suite. Article stripping makes
    // these titles identical; the year requirement is what stops that from
    // becoming a silent wrong import.
    const theHeat = row({ title: "The Heat", year: 2013 });
    const ranked = rankCandidates(theHeat, [title("949", "Heat", 1995)]);
    expect(ranked[0].signals.titleIdentical).toBe(true);
    expect(classifyRanked(theHeat, ranked)).toBe("ambiguous");
  });

  it("is unsupported for a TV episode row regardless of candidates", () => {
    const episode = row({ mediaTypeHint: "episode" });
    const ranked = rankCandidates(episode, [title("a", "Gravity", 2013)]);
    expect(classifyRanked(episode, ranked)).toBe("unsupported");
  });
});

describe("resolveByTitle", () => {
  it("pre-selects a choice ONLY when the bucket auto-imports", () => {
    const confident = resolveByTitle(row(), [title("a", "Gravity", 2013)]);
    expect(confident.bucket).toBe("confident");
    expect(confident.chosen?.id).toBe("a");

    const ambiguous = resolveByTitle(row(), [title("a", "Gravity", 2014)]);
    expect(ambiguous.bucket).toBe("ambiguous");
    // No fallback value sitting there waiting to be committed if the user
    // walks away mid-review.
    expect(ambiguous.chosen).toBeNull();
  });

  it("still offers candidates for an ambiguous row, for the review queue", () => {
    const resolved = resolveByTitle(row(), [
      title("a", "Gravity", 2013),
      title("b", "Gravity", 2013),
    ]);
    expect(resolved.candidates).toHaveLength(2);
    expect(resolved.chosen).toBeNull();
  });

  it("offers no candidates for an unsupported row", () => {
    const resolved = resolveByTitle(row({ mediaTypeHint: "episode" }), [
      title("a", "Ozymandias", 2013),
    ]);
    expect(resolved.candidates).toEqual([]);
    expect(resolved.chosen).toBeNull();
  });

  it("caps the candidate list so the review queue stays scannable", () => {
    const many = Array.from({ length: 12 }, (_, i) => title(`t${i}`, `Gravity ${i}`, 2013));
    expect(resolveByTitle(row(), many).candidates.length).toBeLessThanOrEqual(5);
  });
});

describe("resolveByExternalId", () => {
  it("is exact and pre-chosen", () => {
    const resolved = resolveByExternalId(
      row({ imdbId: "tt1454468" }),
      title("49047", "Gravity", 2013),
    );
    expect(resolved.bucket).toBe("exact");
    expect(resolved.chosen?.id).toBe("49047");
    expect(resolved.candidates[0].reason).toContain("tt1454468");
  });

  it("does not auto-import an unsupported row even with an id match", () => {
    const resolved = resolveByExternalId(
      row({ imdbId: "tt2301451", mediaTypeHint: "episode" }),
      title("62161", "Ozymandias", 2013),
    );
    expect(resolved.bucket).toBe("unsupported");
    expect(resolved.chosen).toBeNull();
  });
});
