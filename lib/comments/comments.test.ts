import { describe, expect, it } from "vitest";

import { CommentError, mapCommentError } from "./errors";
import { isEpisodeScope, isGatedScope, titleScope, episodeScope } from "./types";
import type { Comment } from "./types";
import {
  MAX_COMMENT_LENGTH,
  MAX_REPORT_NOTE_LENGTH,
  isReportReason,
  sanitizeCommentBody,
  validateCommentBody,
  validateReportNote,
} from "./validate";
import { groupIntoThreads } from "./wire";

/** Builds the invisible/bidi characters `sanitizeCommentBody` must strip, at
 *  RUNTIME rather than as literals in this file's source — for the identical
 *  reason `validate.ts` itself builds `INVISIBLE_CONTROL_CHARS` from numeric
 *  code points instead of pasting the characters: they render identically to
 *  nothing in an editor, which makes a literal unreviewable in a diff. */
function invisible(codepoint: number): string {
  return String.fromCharCode(codepoint);
}
const ZERO_WIDTH_SPACE = invisible(0x200b);
const RTL_OVERRIDE = invisible(0x202e);
const LEFT_TO_RIGHT_MARK = invisible(0x200e);

describe("sanitizeCommentBody", () => {
  it("trims leading and trailing whitespace", () => {
    expect(sanitizeCommentBody("  hello  ")).toBe("hello");
  });

  it("collapses 3+ consecutive newlines to exactly 2", () => {
    expect(sanitizeCommentBody("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(sanitizeCommentBody("a\n\n\nb")).toBe("a\n\nb");
  });

  it("does not touch a single blank line (2 newlines)", () => {
    expect(sanitizeCommentBody("a\n\nb")).toBe("a\n\nb");
  });

  it("does not collapse internal single spaces", () => {
    expect(sanitizeCommentBody("a  b   c")).toBe("a  b   c");
  });

  it("strips zero-width and bidi override characters", () => {
    expect(sanitizeCommentBody(`hi${ZERO_WIDTH_SPACE}there`)).toBe("hithere");
    expect(sanitizeCommentBody(`a${RTL_OVERRIDE}b`)).toBe("ab");
    expect(sanitizeCommentBody(`a${LEFT_TO_RIGHT_MARK}b`)).toBe("ab");
  });

  it("strips invisible characters used to spoof visible content, not just pad it", () => {
    // The realistic attack: an invisible char breaking up a word to evade a
    // naive banned-word filter elsewhere, or a bidi override making text
    // display in a different order than it's stored. Both must be gone.
    const spoofed = `nice${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}post`;
    expect(sanitizeCommentBody(spoofed)).toBe("nicepost");
  });
});

describe("validateCommentBody", () => {
  it("accepts an ordinary comment", () => {
    expect(validateCommentBody("Great episode!")).toEqual({
      ok: true,
      value: "Great episode!",
    });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(validateCommentBody("")).toEqual({ ok: false, reason: "empty" });
    expect(validateCommentBody("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateCommentBody("\n\n\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects input that is invisible characters only", () => {
    expect(validateCommentBody(ZERO_WIDTH_SPACE.repeat(5))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("enforces the length cap after sanitizing, not before", () => {
    // Exactly at the limit is fine.
    expect(validateCommentBody("a".repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    // One over is not.
    expect(validateCommentBody("a".repeat(MAX_COMMENT_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
    // Padding with leading/trailing whitespace that sanitizing trims away
    // must not count against the cap — only the SANITIZED value should be
    // measured, since that's the value that actually gets stored.
    const padded = "  " + "a".repeat(MAX_COMMENT_LENGTH) + "  ";
    expect(validateCommentBody(padded)).toEqual({
      ok: true,
      value: "a".repeat(MAX_COMMENT_LENGTH),
    });
  });

  it("returns the SANITIZED value, matching what would actually be stored", () => {
    const result = validateCommentBody(`hi${ZERO_WIDTH_SPACE}\n\n\n\nbye`);
    expect(result).toEqual({ ok: true, value: "hi\n\nbye" });
  });
});

describe("validateReportNote", () => {
  it("collapses a blank note to null rather than an empty string", () => {
    expect(validateReportNote("")).toEqual({ ok: true, value: null });
    expect(validateReportNote("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts and trims a real note", () => {
    expect(validateReportNote("  this is spam  ")).toEqual({
      ok: true,
      value: "this is spam",
    });
  });

  it("enforces its own, shorter length cap", () => {
    expect(validateReportNote("a".repeat(MAX_REPORT_NOTE_LENGTH)).ok).toBe(true);
    expect(validateReportNote("a".repeat(MAX_REPORT_NOTE_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("isReportReason", () => {
  it("accepts exactly the four values the CHECK constraint allows", () => {
    for (const reason of ["spam", "harassment", "spoiler", "other"]) {
      expect(isReportReason(reason), reason).toBe(true);
    }
  });

  it("rejects anything else, including a plausible-looking near miss", () => {
    expect(isReportReason("spoiler_violation")).toBe(false);
    expect(isReportReason("Spam")).toBe(false);
    expect(isReportReason("")).toBe(false);
    expect(isReportReason(null)).toBe(false);
    expect(isReportReason(42)).toBe(false);
  });
});

describe("scope helpers", () => {
  it("titleScope has both season and episode null", () => {
    expect(titleScope("tv", "100")).toEqual({
      mediaType: "tv",
      titleId: "100",
      seasonNumber: null,
      episodeNumber: null,
    });
  });

  it("episodeScope carries both coordinates", () => {
    const scope = episodeScope("tv", "100", 3, 7);
    expect(scope.seasonNumber).toBe(3);
    expect(scope.episodeNumber).toBe(7);
    expect(isEpisodeScope(scope)).toBe(true);
  });

  it("isEpisodeScope is false for a title-level scope", () => {
    expect(isEpisodeScope(titleScope("movie", "1"))).toBe(false);
  });

  it("isGatedScope matches the migration's can_view_comment_scope exactly: episode always gated, movie title gated, tv title open", () => {
    expect(isGatedScope(episodeScope("tv", "1", 1, 1))).toBe(true);
    expect(isGatedScope(titleScope("movie", "1"))).toBe(true);
    expect(isGatedScope(titleScope("tv", "1"))).toBe(false);
  });
});

describe("mapCommentError", () => {
  it("maps a 42501 (RLS WITH CHECK rejection) to forbidden", () => {
    expect(mapCommentError({ code: "42501", message: "policy violation" }).kind).toBe(
      "forbidden",
    );
  });

  it("maps CHECK/NOT NULL violations to invalid_input", () => {
    expect(mapCommentError({ code: "23514", message: "check violation" }).kind).toBe(
      "invalid_input",
    );
    expect(mapCommentError({ code: "23502", message: "not null violation" }).kind).toBe(
      "invalid_input",
    );
  });

  it("maps PGRST116 (no rows) to not_found", () => {
    expect(mapCommentError({ code: "PGRST116" }).kind).toBe("not_found");
  });

  it("recognizes a fetch failure by shape rather than by code", () => {
    expect(mapCommentError(new TypeError("fetch failed")).kind).toBe("network");
  });

  it("passes a CommentError through unchanged", () => {
    const original = new CommentError("rate_limited", "x");
    expect(mapCommentError(original)).toBe(original);
  });

  it("returns unknown rather than guessing at an unrecognized shape", () => {
    expect(mapCommentError({ code: "99999" }).kind).toBe("unknown");
    expect(mapCommentError(null).kind).toBe("unknown");
  });
});

describe("groupIntoThreads", () => {
  function comment(overrides: Partial<Comment>): Comment {
    return {
      id: "c1",
      scope: titleScope("tv", "1"),
      parentId: null,
      author: { id: "u1", username: "alice", displayName: null },
      body: "hi",
      status: "visible",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      editedAt: null,
      deletedAt: null,
      likeCount: 0,
      likedByViewer: false,
      reportedByViewer: false,
      isOwn: false,
      ...overrides,
    };
  }

  it("groups replies under their parent", () => {
    const top = comment({ id: "top", parentId: null });
    const reply1 = comment({ id: "r1", parentId: "top" });
    const reply2 = comment({ id: "r2", parentId: "top" });

    const threads = groupIntoThreads([top, reply1, reply2]);
    expect(threads).toHaveLength(1);
    expect(threads[0].comment.id).toBe("top");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("keeps top-level comments with no replies as empty-reply threads", () => {
    const top = comment({ id: "top" });
    const threads = groupIntoThreads([top]);
    expect(threads).toEqual([{ comment: top, replies: [] }]);
  });

  it("preserves input order (the query is responsible for chronological order)", () => {
    const a = comment({ id: "a", createdAt: new Date("2026-01-01T00:00:00Z") });
    const b = comment({ id: "b", createdAt: new Date("2026-01-02T00:00:00Z") });
    const threads = groupIntoThreads([a, b]);
    expect(threads.map((t) => t.comment.id)).toEqual(["a", "b"]);
  });

  it("drops a reply whose parent is not in the result set (orphaned by hiding/deletion) rather than promoting it to top-level", () => {
    const orphanReply = comment({ id: "r1", parentId: "does-not-exist-in-this-fetch" });
    const threads = groupIntoThreads([orphanReply]);
    expect(threads).toEqual([]);
  });

  it("handles multiple independent threads", () => {
    const topA = comment({ id: "topA" });
    const topB = comment({ id: "topB" });
    const replyToA = comment({ id: "rA", parentId: "topA" });

    const threads = groupIntoThreads([topA, topB, replyToA]);
    expect(threads).toHaveLength(2);
    expect(threads.find((t) => t.comment.id === "topA")?.replies.map((r) => r.id)).toEqual([
      "rA",
    ]);
    expect(threads.find((t) => t.comment.id === "topB")?.replies).toEqual([]);
  });
});
