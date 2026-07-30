import { describe, expect, it } from "vitest";

import { mergeRatingPatch, ratingKey } from "./types";
import type { RatingEntry } from "./types";

const NOW = new Date("2026-07-30T12:00:00.000Z");

describe("ratingKey", () => {
  it("joins mediaType and id", () => {
    expect(ratingKey("movie", "238")).toBe("movie:238");
    expect(ratingKey("tv", "1396")).toBe("tv:1396");
  });
});

describe("mergeRatingPatch — creating a new entry", () => {
  it("creates an entry from a score-only patch", () => {
    const result = mergeRatingPatch(undefined, "238", "movie", { score: 85 }, NOW);
    expect(result).toEqual({
      id: "238",
      mediaType: "movie",
      score: 85,
      note: "",
      updatedAt: NOW,
    });
  });

  it("creates an entry from a note-only patch, with no score", () => {
    const result = mergeRatingPatch(undefined, "238", "movie", { note: "Rewatch soon" }, NOW);
    expect(result).toEqual({
      id: "238",
      mediaType: "movie",
      score: null,
      note: "Rewatch soon",
      updatedAt: NOW,
    });
  });

  it("returns null for an empty patch against no existing entry", () => {
    expect(mergeRatingPatch(undefined, "238", "movie", {}, NOW)).toBeNull();
  });

  it("returns null when the only patch given is an empty note", () => {
    expect(mergeRatingPatch(undefined, "238", "movie", { note: "" }, NOW)).toBeNull();
  });
});

describe("mergeRatingPatch — patching an existing entry", () => {
  const existing: RatingEntry = {
    id: "238",
    mediaType: "movie",
    score: 70,
    note: "First watch",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("patching score alone preserves the existing note", () => {
    const result = mergeRatingPatch(existing, "238", "movie", { score: 95 }, NOW);
    expect(result).toEqual({ ...existing, score: 95, updatedAt: NOW });
  });

  it("patching note alone preserves the existing score", () => {
    const result = mergeRatingPatch(existing, "238", "movie", { note: "Even better on rewatch" }, NOW);
    expect(result).toEqual({ ...existing, note: "Even better on rewatch", updatedAt: NOW });
  });

  it("always bumps updatedAt, even when the values are unchanged", () => {
    const result = mergeRatingPatch(existing, "238", "movie", { score: 70 }, NOW);
    expect(result?.updatedAt).toEqual(NOW);
  });
});

describe("mergeRatingPatch — clearing to empty deletes the record", () => {
  it("clearing score to null, with no note, returns null", () => {
    const existing: RatingEntry = {
      id: "238",
      mediaType: "movie",
      score: 70,
      note: "",
      updatedAt: NOW,
    };
    expect(mergeRatingPatch(existing, "238", "movie", { score: null }, NOW)).toBeNull();
  });

  it("clearing note to empty, with no score, returns null", () => {
    const existing: RatingEntry = {
      id: "238",
      mediaType: "movie",
      score: null,
      note: "some thoughts",
      updatedAt: NOW,
    };
    expect(mergeRatingPatch(existing, "238", "movie", { note: "" }, NOW)).toBeNull();
  });

  it("a whitespace-only note counts as empty", () => {
    const existing: RatingEntry = {
      id: "238",
      mediaType: "movie",
      score: null,
      note: "some thoughts",
      updatedAt: NOW,
    };
    expect(mergeRatingPatch(existing, "238", "movie", { note: "   \n  " }, NOW)).toBeNull();
  });

  it("clearing score does NOT delete the record if a note remains", () => {
    const existing: RatingEntry = {
      id: "238",
      mediaType: "movie",
      score: 70,
      note: "kept this",
      updatedAt: NOW,
    };
    const result = mergeRatingPatch(existing, "238", "movie", { score: null }, NOW);
    expect(result).toEqual({ ...existing, score: null, updatedAt: NOW });
  });

  it("clearing BOTH in one patch returns null", () => {
    const existing: RatingEntry = {
      id: "238",
      mediaType: "movie",
      score: 70,
      note: "kept this",
      updatedAt: NOW,
    };
    const result = mergeRatingPatch(existing, "238", "movie", { score: null, note: "" }, NOW);
    expect(result).toBeNull();
  });
});

describe("mergeRatingPatch — score clamping", () => {
  it("rounds a fractional score", () => {
    expect(mergeRatingPatch(undefined, "1", "movie", { score: 72.6 }, NOW)?.score).toBe(73);
  });

  it("clamps above 100 down to 100", () => {
    expect(mergeRatingPatch(undefined, "1", "movie", { score: 150 }, NOW)?.score).toBe(100);
  });

  it("clamps below 0 up to 0", () => {
    expect(mergeRatingPatch(undefined, "1", "movie", { score: -20 }, NOW)?.score).toBe(0);
  });

  it("0 is a real score, not treated as empty", () => {
    const result = mergeRatingPatch(undefined, "1", "movie", { score: 0 }, NOW);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(0);
  });
});

describe("mergeRatingPatch — note length cap", () => {
  it("truncates a note past the 2000-character cap", () => {
    const long = "x".repeat(3000);
    const result = mergeRatingPatch(undefined, "1", "movie", { note: long }, NOW);
    expect(result?.note.length).toBe(2000);
  });
});
