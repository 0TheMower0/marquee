"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { committableRows } from "@/lib/import/commit";
import { buildReviewUnits } from "@/lib/import/review-units";
import type { MatchBucket, ResolvedRow } from "@/lib/import/types";

/**
 * What will happen, before anything happens.
 *
 * The counts are real rather than estimated, because resolution has already
 * finished by the time this renders — that ordering is the whole reason the
 * pipeline resolves before previewing rather than after.
 */

interface Bucketed {
  willImport: ResolvedRow[];
  needsReview: ResolvedRow[];
  unsupported: ResolvedRow[];
  skipped: ResolvedRow[];
}

function bucket(rows: readonly ResolvedRow[]): Bucketed {
  const out: Bucketed = { willImport: [], needsReview: [], unsupported: [], skipped: [] };
  for (const row of rows) {
    if (row.skipped) out.skipped.push(row);
    else if (row.bucket === "unsupported") out.unsupported.push(row);
    else if (row.chosen !== null) out.willImport.push(row);
    else out.needsReview.push(row);
  }
  return out;
}

const BUCKET_LABEL: Record<MatchBucket, string> = {
  exact: "matched by IMDb id",
  confident: "matched by title and year",
  ambiguous: "needs review",
  unmatched: "no match found",
  unsupported: "not supported yet",
};

function RowList({ rows, emptyNote }: { rows: readonly ResolvedRow[]; emptyNote: string }) {
  if (rows.length === 0) return <p className="text-meta text-fg-subtle">{emptyNote}</p>;

  return (
    <ul className="divide-line-subtle max-h-72 divide-y overflow-y-auto">
      {rows.map((row) => (
        <li key={row.row.sourceRowId} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="text-body-sm text-fg block truncate">
              {row.row.title || <span className="italic">(no title)</span>}
              {row.row.year !== null && (
                <span className="text-fg-subtle"> ({row.row.year})</span>
              )}
            </span>
            <span className="text-meta text-fg-subtle">
              line {row.row.sourceLine} · {BUCKET_LABEL[row.bucket]}
              {row.chosen && ` → ${row.chosen.name}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ImportPreview({
  rows,
  fileNames,
  onReview,
  onCommit,
  onCancel,
  saveWarning,
}: {
  rows: readonly ResolvedRow[];
  fileNames: readonly string[];
  onReview: () => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Set when the job could not be persisted — see `saveJob`. Shown here
   *  rather than swallowed, because it changes what the user should DO. */
  saveWarning: string | null;
}) {
  const groups = useMemo(() => bucket(rows), [rows]);
  const [open, setOpen] = useState<keyof Bucketed | null>(null);

  const committable = committableRows(rows).length;

  // The number of DECISIONS, which is not the number of rows: a show's
  // episodes and a film's rewatches each collapse to one. Counting rows here
  // would advertise "review 3,000 rows" for what is actually 14 questions,
  // and someone reading that would reasonably decide not to bother.
  const decisions = useMemo(() => buildReviewUnits(rows).length, [rows]);

  const tiles: { key: keyof Bucketed; label: string; count: number; tone: string }[] = [
    {
      key: "willImport",
      label: "will import",
      count: groups.willImport.length,
      tone: "border-accent/40 bg-accent/8 text-accent",
    },
    {
      key: "needsReview",
      label: "need review",
      count: groups.needsReview.length,
      tone: "border-warning/40 bg-warning/10 text-warning",
    },
    {
      key: "unsupported",
      label: "not supported",
      count: groups.unsupported.length,
      tone: "border-line bg-surface text-fg-muted",
    },
    {
      key: "skipped",
      label: "skipped",
      count: groups.skipped.length,
      tone: "border-line bg-surface text-fg-muted",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-display-md text-fg uppercase">Ready to import</h2>
        <p className="text-body-sm text-fg-muted mt-1">
          From {fileNames.map((name) => <code key={name}>{name}</code>).reduce<React.ReactNode[]>(
            (acc, node, i) => (i === 0 ? [node] : [...acc, ", ", node]),
            [],
          )}
          {" — "}
          {rows.length} row{rows.length === 1 ? "" : "s"} read.
        </p>
      </div>

      {/* The single most important sentence on this screen. */}
      <p className="border-accent/30 bg-accent/8 text-body-sm text-fg rounded-md border px-4 py-3">
        <strong>Nothing has been written yet.</strong> Your library is unchanged
        until you choose to import below.
      </p>

      {saveWarning && (
        <p
          role="alert"
          className="border-warning/40 bg-warning/10 text-body-sm text-fg rounded-md border px-4 py-3"
        >
          {saveWarning}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            aria-expanded={open === tile.key}
            onClick={() => setOpen(open === tile.key ? null : tile.key)}
            className={cn("rounded-lg border p-3 text-left transition-colors", tile.tone)}
            disabled={tile.count === 0}
          >
            <span className="font-display block text-display-lg">{tile.count}</span>
            <span className="text-meta uppercase">{tile.label}</span>
          </button>
        ))}
      </div>

      {open && (
        <section
          aria-label={`${tiles.find((t) => t.key === open)?.label} rows`}
          className="border-line-subtle rounded-lg border p-3"
        >
          <RowList
            rows={groups[open]}
            emptyNote="Nothing in this group."
          />
        </section>
      )}

      {/* The copy below is built as ONE template string rather than
          interleaved JSX text and expressions: the latter silently loses the
          space around an expression at a line break, which shipped here once
          as "2 rowscouldn't be matched".

          This comment sits here, in children position, and NOT inside the
          `&& ( ... )` below — inside parentheses a leading `{` starts an
          object literal, not a JSX comment, and the file stops parsing. */}
      {groups.needsReview.length > 0 && (
        <p className="text-body-sm text-fg-muted">
          {`${groups.needsReview.length} ${
            groups.needsReview.length === 1 ? "row" : "rows"
          } couldn't be matched confidently${
            decisions === groups.needsReview.length
              ? ""
              : `, but they only need ${decisions} decision${decisions === 1 ? "" : "s"} — episodes of one show, and repeat viewings of one film, are answered together`
          }. Reviewing is optional — importing now simply leaves them out, and they stay here if you come back.`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {groups.needsReview.length > 0 && (
          <Button type="button" onClick={onReview}>
            {`Review ${decisions} title${decisions === 1 ? "" : "s"}`}
          </Button>
        )}
        <Button
          type="button"
          variant={groups.needsReview.length > 0 ? "outline" : "primary"}
          disabled={committable === 0}
          onClick={onCommit}
        >
          Import {committable} title{committable === 1 ? "" : "s"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Start over
        </Button>
      </div>

      {groups.unsupported.length > 0 && (
        <p className="text-meta text-fg-subtle">
          <Badge variant="neutral" size="sm">
            note
          </Badge>{" "}
          TV episode rows can&rsquo;t be imported yet — they&rsquo;re listed above
          rather than dropped silently, so you can see they were in the file.
        </p>
      )}
    </div>
  );
}
