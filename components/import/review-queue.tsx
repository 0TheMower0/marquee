"use client";

import { useEffect, useMemo, useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/tracking/progress-bar";
import type { TitleSummary } from "@/lib/content/types";
import {
  buildReviewUnits,
  isUnitPending,
  sortUnitsEasiestFirst,
  type ReviewUnit,
} from "@/lib/import/review-units";
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

function formatScore(score: number | null): string | null {
  return score === null ? null : `${score}/100`;
}

/**
 * The line that makes a 62-row unit legible: what a single decision covers.
 *
 * Rendered only when a unit holds more than one row, so the common case — one
 * film, one decision — gains no extra chrome.
 */
function unitCoverage(unit: ReviewUnit): string | null {
  if (unit.rowCount <= 1) return null;

  if (unit.episodeCount > 0) {
    const seasons = `${unit.seasonCount} season${unit.seasonCount === 1 ? "" : "s"}`;
    return `${unit.episodeCount} episodes across ${seasons}`;
  }
  // A film with several diary rows: rewatches.
  return `${unit.rowCount} viewings`;
}

export function ReviewQueue({
  rows,
  onDecide,
  onFinish,
}: {
  rows: readonly ResolvedRow[];
  /** Applied against EVERY original-array index the unit covers, so one
   *  answer resolves all of them. */
  onDecide: (
    indices: readonly number[],
    decision: { chosen: TitleSummary | null; skipped: boolean },
  ) => void;
  onFinish: () => void;
}) {
  // Built ONCE, from the rows as they first arrived. Recomputing as decisions
  // land would reshuffle the queue under the user's cursor mid-review, which
  // is the fastest way to make someone mis-click.
  //
  // A lazy `useState` initializer rather than a ref read during render —
  // `react-hooks/refs` rejects the latter, correctly, and this expresses the
  // same intent honestly: the value is derived once at mount and then owned.
  // Safe because the resolved set does not change SHAPE after resolution
  // finishes; only decisions on it do.
  const [units] = useState(() => sortUnitsEasiestFirst(buildReviewUnits(rows)));

  const pending = useMemo(
    () => units.filter((unit) => isUnitPending(unit, rows)),
    [units, rows],
  );

  const [position, setPosition] = useState(0);
  const [searching, setSearching] = useState(false);

  const total = units.length;
  const reviewed = total - pending.length;

  const unit = pending[Math.min(position, pending.length - 1)] ?? null;
  const current = unit?.representative ?? null;

  function decide(decision: { chosen: TitleSummary | null; skipped: boolean }) {
    if (!unit) return;
    setSearching(false);
    // One answer, every row it covers. This is what makes 3,000 episodes 14
    // decisions rather than a faster way of making 3,000.
    onDecide(unit.indices, decision);
    // Position is NOT advanced: resolving the current unit removes it from
    // `pending`, so the same position naturally shows the next one. Advancing
    // as well would silently skip one.
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

  if (!current || !unit) {
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
              against the actual file rather than against our summary of it.
              A grouped unit shows the RANGE, for the same reason. */}
          <span>
            {unit.firstLine === unit.lastLine
              ? `line ${unit.firstLine}`
              : `lines ${unit.firstLine}–${unit.lastLine}`}
          </span>
        </div>

        <p className="font-display text-display-md text-fg mt-2 uppercase">
          {row.title || <span className="text-fg-subtle italic">(no title)</span>}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.year !== null && <Badge variant="outline">{row.year}</Badge>}
          {formatScore(row.score) && <Badge variant="accent">{formatScore(row.score)}</Badge>}
          {/* A single row shows its own date; a group shows its span, since
              62 individual dates would be noise. */}
          {unit.rowCount === 1 && row.watchedOn && (
            <Badge variant="secondary">watched {row.watchedOn}</Badge>
          )}
          {row.isRewatch && unit.rowCount === 1 && <Badge variant="neutral">rewatch</Badge>}
          {row.originalTitle && (
            <span className="text-meta text-fg-subtle italic">{row.originalTitle}</span>
          )}
        </div>

        {/* What this ONE answer covers. Only shown when it covers more than
            the row above, so the common case gains no extra chrome. */}
        {unitCoverage(unit) && (
          <p className="text-body-sm text-accent mt-3">
            {unitCoverage(unit)}
            {unit.earliestDate && unit.latestDate && (
              <span className="text-fg-subtle">
                {unit.earliestDate === unit.latestDate
                  ? ` · ${unit.earliestDate}`
                  : ` · ${unit.earliestDate} to ${unit.latestDate}`}
              </span>
            )}
          </p>
        )}
        {unit.rowCount > 1 && (
          <p className="text-meta text-fg-subtle mt-1">
            One answer here resolves all of them.
          </p>
        )}
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
