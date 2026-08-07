"use client";

import { useEffect, useRef, useState } from "react";

import { PosterImage } from "@/components/title/poster-image";
import { Button } from "@/components/ui/button";
import { PlusIcon, SearchIcon, SpinnerIcon } from "@/components/ui/icons";
import { httpProvider } from "@/lib/content/http";
import type { TitleSummary } from "@/lib/content/types";
import type { ListItemEntry } from "@/lib/lists";

const DEBOUNCE_MS = 300;
const POSTER_SIZES = "48px";

interface SearchResult {
  /** The trimmed query this result was fetched for — compared against the
   *  CURRENT query at render time so "loading" needs no state variable of
   *  its own, same derivation `search-view.tsx` uses and for the same
   *  reason: `setState` synchronously in an effect body fails the
   *  `react-hooks/set-state-in-effect` lint rule. */
  forQuery: string;
  status: "done" | "error";
  items: TitleSummary[];
}

/**
 * Inline search-and-add, scoped to one list. Deliberately its own small
 * effect rather than reusing `SearchView` wholesale — that component owns a
 * whole page (media-type tabs, URL-ish state, a big empty state); this needs
 * only a text box, a short result list, and an "Add" button per row. Shares
 * its debounce/cancellation shape (AbortController + request-id ref) with
 * `search-view.tsx` because that shape is correct here for the same reason.
 */
export function AddItemSearch({
  existingKeys,
  onAdd,
}: {
  /** `${mediaType}:${titleId}` for everything already on the list, so an
   *  already-added title shows as added rather than inviting a duplicate
   *  click (the server tolerates it — 23505 is handled gracefully — but
   *  disabling the button is a clearer signal than a silent no-op). */
  existingKeys: ReadonlySet<string>;
  /** REJECTS with a user-facing message string on failure. */
  onAdd: (title: TitleSummary) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

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

  async function handleAdd(title: TitleSummary) {
    const key = `${title.mediaType}:${title.id}`;
    setAddingKey(key);
    setError(null);
    try {
      await onAdd(title);
    } catch (message) {
      setError(typeof message === "string" ? message : "Couldn't add that title.");
    } finally {
      setAddingKey(null);
    }
  }

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const fresh = result !== null && result.forQuery === trimmed;

  return (
    <div className="space-y-3">
      <div className="relative">
        <SearchIcon className="text-fg-subtle pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for a film or series to add…"
          aria-label="Search titles to add to this list"
          className="bg-ink border-line text-fg placeholder:text-fg-subtle h-10 w-full rounded-md border pr-3 pl-9 text-body-sm"
        />
      </div>

      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}

      {hasQuery && !fresh && (
        <p className="text-meta text-fg-subtle flex items-center gap-2">
          <SpinnerIcon className="size-4 motion-safe:animate-spin" /> Searching…
        </p>
      )}

      {fresh && result.status === "error" && (
        <p className="text-meta text-danger">Search failed. Try again.</p>
      )}

      {fresh && result.status === "done" && result.items.length === 0 && (
        <p className="text-meta text-fg-subtle">No matches.</p>
      )}

      {fresh && result.status === "done" && result.items.length > 0 && (
        <ul className="divide-line-subtle max-h-80 divide-y overflow-y-auto">
          {result.items.map((title) => {
            const key = `${title.mediaType}:${title.id}`;
            const already = existingKeys.has(key);
            return (
              <li key={key} className="flex items-center gap-3 py-2">
                <div className="relative aspect-[2/3] w-8 shrink-0 overflow-hidden rounded-xs">
                  <PosterImage
                    src={title.posterUrl}
                    alt=""
                    name={title.name}
                    placeholder={title.placeholder}
                    sizes={POSTER_SIZES}
                    initialsClassName="text-body-sm"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-fg truncate">{title.name}</p>
                  <p className="text-meta text-fg-subtle">
                    {title.year ?? "—"} · {title.mediaType === "tv" ? "Series" : "Film"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={already ? "ghost" : "outline"}
                  disabled={already}
                  isLoading={addingKey === key}
                  onClick={() => void handleAdd(title)}
                >
                  {already ? (
                    "Added"
                  ) : (
                    <>
                      <PlusIcon className="size-4" /> Add
                    </>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function itemKey(mediaType: ListItemEntry["mediaType"], titleId: string): string {
  return `${mediaType}:${titleId}`;
}
