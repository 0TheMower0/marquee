"use client";

import { useEffect, useMemo, useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/tracking/progress-bar";
import type { TitleSummary } from "@/lib/content/types";
import { SOURCE_LABEL, type ResolvedRow } from "@/lib/import/types";
import { cn } from "@/lib/utils/cn";

import { ManualSearch } from "./manual-search";

/**
 * The review queue.
 *
 * ============================================================================
 * ONE ROW AT A TIME, KEYBOARD FIRST. THIS IS THE FEATURE.
 * ============================================================================
 * The obvious alternative — a table of 200 rows with a dropdown per row — is
 * faster to build and actively worse at the only job this screen has. A table
 * invites skimming, and a skimmed decision is precisely how a wrong match
 * gets committed. A wrong match is worse than no match, because the user
 * never notices it: an unmatched row is visibly unmatched, while a wrongly
 * matched one looks exactly like a correct one forever.
 *
 * So: one row, full attention, and number keys rather than a mouse. Two
 * hundred rows through a mouse is how people start rushing, and rushing
 * produces exactly the invisible errors the whole design exists to prevent.
 *
 * Every escape from this screen is safe. There is no "accept the rest" —
 * `committableRows()` only ever commits rows that were decided, so leaving
 * early imports less, never something guessed.
 */

/** Easiest first: the highest-scoring top candidate leads. Momentum early,
 *  and the genuinely hard rows cluster at the end where a user can stop and
 *  leave them pending rather than grinding through them tired. */
function reviewOrder(rows: readonly ResolvedRow[]): number[] {
  return rows
    .map((row, index) => ({ index, top: row.candidates[0]?.score ?? -1 }))
    .sort((a, b) => b.top - a.top || a.index - b.index)
    .map(({ index }) => index);
}

function needsReview(row: ResolvedRow): boolean {
  return (
    (row.bucket === "ambiguous" || row.bucket === "unmatched") &&
    !row.skipped &&
    row.chosen === null
  );
}

function formatScore(score: number | null): string | null {
  return score === null ? null : `${score}/100`;
}

export function ReviewQueue({
  rows,
  onDecide,
  onFinish,
}: {
  rows: readonly ResolvedRow[];
  /** Applied against the row's index in the ORIGINAL array, so a decision
   *  survives re-sorting and resuming. */
  onDecide: (index: number, decision: { chosen: TitleSummary | null; skipped: boolean }) => void;
  onFinish: () => void;
}) {
  // Computed once from the rows as they arrived. Recomputing as decisions
  // land would reshuffle the queue under the user's cursor mid-review.
  const order = useMemo(() => reviewOrder(rows), [rows]);
  const pending = useMemo(() => order.filter((index) => needsReview(rows[index])), [order, rows]);

  const [position, setPosition] = useState(0);
  const [searching, setSearching] = useState(false);

  const total = useMemo(
    () => order.filter((index) => rows[index].bucket === "ambiguous" || rows[index].bucket === "unmatched").length,
    [order, rows],
  );
  const remaining = pending.length;
  const reviewed = total - remaining;

  const index = pending[Math.min(position, pending.length - 1)];
  const current = index === undefined ? null : rows[index];

  function decide(decision: { chosen: TitleSummary | null; skipped: boolean }) {
    if (index === undefined) return;
    setSearching(false);
    onDecide(index, decision);
    // Position is NOT advanced: resolving the current row removes it from
    // `pending`, so the same position naturally shows the next one. Advancing
    // as well would silently skip a row.
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A shortcut must never fire while the user is typing a search query.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!current) return;

      if (event.key >= "1" && event.key <= "9") {
        const pick = current.candidates[Number(event.key) - 1];
        if (pick) {
          event.preventDefault();
          decide({ chosen: pick.summary, skipped: false });
        }
        return;
      }

      switch (event.key) {
        case "s":
        case "S":
          event.preventDefault();
          decide({ chosen: null, skipped: true });
          break;
        case "/":
          event.preventDefault();
          setSearching(true);
          break;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          setPosition((p) => Math.min(p + 1, pending.length - 1));
          break;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          setPosition((p) => Math.max(p - 1, 0));
          break;
        case "Escape":
          setSearching(false);
          break;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  if (!current) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="font-display text-display-md text-fg uppercase">Review complete</h2>
        <p className="text-body-sm text-fg-muted mx-auto max-w-prose">
          Every ambiguous row has a decision. Nothing has been written yet.
        </p>
        <Button type="button" onClick={onFinish}>
          Continue
        </Button>
      </div>
    );
  }

  const { row } = current;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-display-md text-fg uppercase">
            Reviewing {reviewed + 1} of {total}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={onFinish}>
            Finish later
          </Button>
        </div>
        <ProgressBar percent={total === 0 ? 100 : Math.round((reviewed / total) * 100)} />
      </div>

      {/* --- the raw row, exactly as it appeared -------------------------- */}
      <section
        aria-label="Row from your file"
        className="border-line-subtle bg-surface rounded-lg border p-4"
      >
        <div className="text-meta text-fg-subtle flex flex-wrap items-center gap-2 uppercase">
          <span>From your file</span>
          <span>·</span>
          <span>{SOURCE_LABEL[row.source]}</span>
          <span>·</span>
          {/* The line number matters: it lets the user check our reading
              against the actual file rather than against our summary of it. */}
          <span>line {row.sourceLine}</span>
        </div>

        <p className="font-display text-display-md text-fg mt-2 uppercase">
          {row.title || <span className="text-fg-subtle italic">(no title)</span>}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.year !== null && <Badge variant="outline">{row.year}</Badge>}
          {formatScore(row.score) && <Badge variant="accent">{formatScore(row.score)}</Badge>}
          {row.watchedOn && <Badge variant="secondary">watched {row.watchedOn}</Badge>}
          {row.isRewatch && <Badge variant="neutral">rewatch</Badge>}
          {row.originalTitle && (
            <span className="text-meta text-fg-subtle italic">{row.originalTitle}</span>
          )}
        </div>
      </section>

      {/* --- candidates ---------------------------------------------------- */}
      <section aria-label="Suggested matches" className="space-y-2">
        <h3 className="text-body-sm text-fg font-medium">
          {current.bucket === "unmatched" ? "No matches found" : "Best matches"}
        </h3>

        {current.candidates.length === 0 ? (
          <p className="text-body-sm text-fg-muted">
            Nothing came back for this row. Search manually, or skip it.
          </p>
        ) : (
          <ul className="space-y-2">
            {current.candidates.map((candidate, rank) => (
              <li key={`${candidate.summary.mediaType}:${candidate.summary.id}`}>
                <button
                  type="button"
                  onClick={() => decide({ chosen: candidate.summary, skipped: false })}
                  className={cn(
                    "border-line-subtle hover:border-accent flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors",
                  )}
                >
                  {/* The same number that picks it from the keyboard, shown
                      so the shortcut is discoverable rather than documented. */}
                  <kbd className="bg-overlay text-fg-muted text-meta flex size-6 shrink-0 items-center justify-center rounded-xs font-mono">
                    {rank + 1}
                  </kbd>
                  <span className="relative aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-xs">
                    <PosterImage
                      src={candidate.summary.posterUrl}
                      alt=""
                      name={candidate.summary.name}
                      placeholder={candidate.summary.placeholder}
                      sizes="40px"
                      initialsClassName="text-body-sm"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-body-sm text-fg block truncate">
                      {candidate.summary.name}
                    </span>
                    <span className="text-meta text-fg-subtle block">
                      {candidate.summary.year ?? "—"} ·{" "}
                      {candidate.summary.mediaType === "tv" ? "Series" : "Film"}
                    </span>
                    {/* Generated from the scoring signals, not the score —
                        "84 points" tells a user nothing. */}
                    <span className="text-meta text-fg-subtle block italic">
                      {candidate.reason}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {searching ? (
        <ManualSearch
          initialQuery={row.title}
          onPick={(title) => decide({ chosen: title, skipped: false })}
          onClose={() => setSearching(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setSearching(true)}>
            Search manually
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => decide({ chosen: null, skipped: true })}
          >
            Skip this row
          </Button>
        </div>
      )}

      <p className="text-meta text-fg-subtle">
        <kbd className="text-fg-muted">1</kbd>–<kbd className="text-fg-muted">9</kbd> pick ·{" "}
        <kbd className="text-fg-muted">/</kbd> search · <kbd className="text-fg-muted">s</kbd> skip
        · <kbd className="text-fg-muted">↑</kbd>
        <kbd className="text-fg-muted">↓</kbd> move between rows
      </p>
    </div>
  );
}
