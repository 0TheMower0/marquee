import type { ExternalRating, RatingScale, RatingSource } from "@/lib/content/types";
import { cn } from "@/lib/utils/cn";

/**
 * The five-source ratings row.
 *
 * Composes TMDB's own score (already on `Title.rating`, so never re-fetched)
 * with whatever `getExternalRatings()` returned. Each source keeps its native
 * scale — /10, %, /100 — because that is how people recognise them; a single
 * normalized percentage would be less informative, not more.
 *
 * ## Degrades per source, by construction
 *
 * The row is built by mapping over the ratings that actually exist. A source
 * OMDb had no data for is simply not in the array, so it renders nothing —
 * there is no per-source "unavailable" placeholder to get wrong, and no
 * arrangement of missing sources can produce an empty box. If every external
 * source is missing the row still renders with TMDB alone, which is the
 * guarantee that matters: a secondary API being down never costs the user the
 * rating they'd have seen anyway.
 *
 * ## Brand colours, deliberately not the page accent
 *
 * Everything else on this page re-tints with the Step 2 artwork accent. These
 * marks intentionally do not: the entire value of showing five sources is that
 * you can tell them apart at a glance, and IMDb yellow / RT red / Metacritic
 * green are load-bearing recognition cues. Re-tinting them all to one
 * extracted colour would make the row prettier and useless. The TMDB entry
 * does use `text-accent`, since TMDB is "this app's own" score.
 */

/** Typographic marks, not the official logo files. Rendering brand wordmarks
 *  in brand colours is nominative use and needs no binary assets committed to
 *  the repo; dropping in real SVG logos later means changing only this map. */
const SOURCE_META: Record<RatingSource, { label: string; mark: string }> = {
  tmdb: { label: "TMDB", mark: "TMDB" },
  imdb: { label: "IMDb", mark: "IMDb" },
  rotten_tomatoes: { label: "Rotten Tomatoes", mark: "RT" },
  metacritic: { label: "Metacritic", mark: "MC" },
};

/**
 * Metacritic's own green / yellow / red score bands, at its published
 * thresholds (61+ favourable, 40-60 mixed, below 40 unfavourable).
 *
 * Two reasons this is worth the extra branch. It is how Metacritic actually
 * presents a Metascore, so it reads as authentic rather than as our
 * invention — and it resolves a genuine recognisability problem: Metacritic's
 * flat brand yellow (#ffcc33) sits almost on top of IMDb's (#f5c518), so a
 * static-colour version of this row had two near-identical yellow chips side
 * by side, which defeats the whole purpose of colour-coding the sources.
 */
function metacriticBand(value: number): string {
  if (value >= 61) return "text-[#00ce7a] border-[#00ce7a]/40";
  if (value >= 40) return "text-[#ffbd3f] border-[#ffbd3f]/40";
  return "text-[#ff6874] border-[#ff6874]/40";
}

function markClassName(rating: ExternalRating): string {
  switch (rating.source) {
    case "tmdb":
      // The only source that re-tints with the page: TMDB is "this app's own"
      // score, so it belongs to the artwork palette rather than to a brand.
      return "text-accent border-accent/40";
    case "imdb":
      return "text-[#f5c518] border-[#f5c518]/40";
    case "rotten_tomatoes":
      return "text-[#fa320a] border-[#fa320a]/40";
    case "metacritic":
      return metacriticBand(rating.value);
  }
}

function formatValue(value: number, scale: RatingScale): string {
  switch (scale) {
    case "ten":
      return `${value.toFixed(1)}`;
    case "percent":
      return `${Math.round(value)}%`;
    case "hundred":
      return `${Math.round(value)}`;
  }
}

/** The denominator, shown small next to the value. `%` is self-describing, so
 *  it gets no suffix — "85%/100" would be nonsense. */
function scaleSuffix(scale: RatingScale): string | null {
  switch (scale) {
    case "ten":
      return "/10";
    case "hundred":
      return "/100";
    case "percent":
      return null;
  }
}

function formatVotes(votes: number): string {
  if (votes >= 1_000_000) return `${(votes / 1_000_000).toFixed(1)}M`;
  if (votes >= 1_000) return `${Math.round(votes / 1_000)}K`;
  return String(votes);
}

function RatingChip({ rating }: { rating: ExternalRating }) {
  const meta = SOURCE_META[rating.source];
  const suffix = scaleSuffix(rating.scale);

  return (
    <li className="bg-surface border-line-subtle flex items-center gap-2.5 rounded-lg border px-3 py-2">
      <span
        aria-hidden="true"
        className={cn(
          "font-display flex h-6 shrink-0 items-center rounded-xs border px-1.5 text-meta-sm",
          markClassName(rating),
        )}
      >
        {meta.mark}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-fg text-body-sm tabular-nums">
          <span className="sr-only">{meta.label}: </span>
          {formatValue(rating.value, rating.scale)}
          {suffix && <span className="text-fg-subtle text-meta-sm">{suffix}</span>}
        </span>
        {rating.votes !== null && (
          <span className="text-fg-subtle text-meta-sm tabular-nums">
            {formatVotes(rating.votes)} votes
          </span>
        )}
      </span>
    </li>
  );
}

export function RatingsRow({
  tmdbRating,
  external,
}: {
  /** TMDB's own community score, 0–10. Null when TMDB has none. */
  tmdbRating: number | null;
  external: ExternalRating[];
}) {
  const all: ExternalRating[] = [
    ...(tmdbRating !== null
      ? [{ source: "tmdb" as const, value: tmdbRating, scale: "ten" as const, votes: null }]
      : []),
    ...external,
  ];

  // Nothing at all to show — no TMDB score AND no external ones. Renders
  // nothing rather than an empty heading, same as every other optional
  // section on this page.
  if (all.length === 0) return null;

  return (
    <section aria-labelledby="ratings-heading">
      <h2 id="ratings-heading" className="font-display text-display-md text-fg uppercase">
        Ratings
      </h2>
      <ul className="mt-4 flex flex-wrap gap-3">
        {all.map((rating) => (
          <RatingChip key={rating.source} rating={rating} />
        ))}
      </ul>
    </section>
  );
}

/** Reserves the row's height while OMDb is in flight, so the content below it
 *  doesn't jump when the ratings stream in. Matches RatingChip's box: 6px+6px
 *  padding around a ~34px two-line body. */
export function RatingsRowSkeleton() {
  return (
    <section aria-hidden="true">
      <h2 className="font-display text-display-md text-fg uppercase">Ratings</h2>
      <ul className="mt-4 flex flex-wrap gap-3">
        {[0, 1, 2, 3].map((i) => (
          <li
            key={i}
            className="bg-surface border-line-subtle h-[50px] w-[132px] animate-pulse rounded-lg border"
          />
        ))}
      </ul>
    </section>
  );
}
