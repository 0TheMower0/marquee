"use client";

import { useEffect, useRef, useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import { Button } from "@/components/ui/button";
import { SpinnerIcon } from "@/components/ui/icons";
import { httpProvider } from "@/lib/content/http";
import type { TitleSummary } from "@/lib/content/types";

const DEBOUNCE_MS = 300;

interface SearchState {
  /** Compared against the CURRENT query at render time, so "loading" needs
   *  no state of its own — the derivation `search-view.tsx` documents, and
   *  the reason a synchronous `setState` never appears in the effect below. */
  forQuery: string;
  status: "done" | "error";
  items: TitleSummary[];
}

/**
 * The review queue's escape hatch, opened with `/`.
 *
 * Deliberately not `AddItemSearch` from the lists feature: that component's
 * verbs are "Add"/"Added" against a collection, and its per-row disabled
 * state is driven by list membership. Here the verb is "use this match" and
 * there is no membership. Same debounce and cancellation shape, different
 * meaning.
 */
export function ManualSearch({
  initialQuery,
  onPick,
  onClose,
}: {
  initialQuery: string;
  onPick: (title: TitleSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<SearchState | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const requestId = ++requestIdRef.current;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      httpProvider
        .searchTitles(trimmed, { signal: controller.signal })
        .then((page) => {
          if (requestId !== requestIdRef.current) return;
          setResult({ forQuery: trimmed, status: "done", items: page.items });
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setResult({ forQuery: trimmed, status: "error", items: [] });
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const trimmed = query.trim();
  const fresh = result !== null && result.forQuery === trimmed;

  return (
    <div className="border-line-subtle bg-surface space-y-3 rounded-md border p-3">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Stopped from reaching the queue's document-level shortcuts, which
          // would otherwise read every keystroke as a candidate pick.
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
        placeholder="Search TMDB…"
        aria-label="Search for the correct title"
        className="bg-ink border-line text-fg placeholder:text-fg-subtle h-10 w-full rounded-md border px-3 text-body-sm"
      />

      {trimmed.length > 0 && !fresh && (
        <p className="text-meta text-fg-subtle flex items-center gap-2">
          <SpinnerIcon className="size-4 motion-safe:animate-spin" /> Searching…
        </p>
      )}

      {fresh && result.status === "error" && (
        <p className="text-meta text-danger">Search failed. Try again.</p>
      )}

      {fresh && result.status === "done" && result.items.length === 0 && (
        <p className="text-meta text-fg-subtle">No matches for that search.</p>
      )}

      {fresh && result.status === "done" && result.items.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {result.items.map((title) => (
            <li key={`${title.mediaType}:${title.id}`}>
              <button
                type="button"
                onClick={() => onPick(title)}
                className="hover:bg-overlay flex w-full items-center gap-3 rounded-md p-2 text-left"
              >
                <span className="relative aspect-[2/3] w-8 shrink-0 overflow-hidden rounded-xs">
                  <PosterImage
                    src={title.posterUrl}
                    alt=""
                    name={title.name}
                    placeholder={title.placeholder}
                    sizes="32px"
                    initialsClassName="text-body-sm"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-body-sm text-fg block truncate">{title.name}</span>
                  <span className="text-meta text-fg-subtle">
                    {title.year ?? "—"} · {title.mediaType === "tv" ? "Series" : "Film"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
}
