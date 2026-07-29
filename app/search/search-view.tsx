"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { TitleGrid } from "@/components/title/title-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertIcon, SearchIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { ContentError, type ContentErrorKind } from "@/lib/content/errors";
import { httpProvider } from "@/lib/content/http";
import type { MediaType, TitleSummary } from "@/lib/content/types";

const DEBOUNCE_MS = 300;

type MediaFilter = "all" | MediaType;

interface SearchResult {
  /** `${trimmedQuery}::${mediaFilter}` this result was fetched for. Render
   *  compares it against the CURRENT query/filter rather than trusting a
   *  separate "loading" flag — see the note above the effect below. */
  forKey: string;
  status: "empty" | "error" | "results";
  items: TitleSummary[];
  errorMessage: string | null;
}

const ERROR_COPY: Record<ContentErrorKind, string> = {
  not_found: "That search couldn't be completed.",
  unauthorized: "The content source rejected the request.",
  rate_limited: "Too many searches right now — wait a moment and try again.",
  network:
    "Couldn't reach the content source. Check your connection and try again.",
  unknown: "Something went wrong running that search.",
};

function resultKey(query: string, mediaFilter: MediaFilter): string {
  return `${query}::${mediaFilter}`;
}

export function SearchView() {
  const [query, setQuery] = useState("");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  // Bumped by the retry button to force the effect below to re-run even
  // though neither query nor mediaFilter changed.
  const [retryNonce, setRetryNonce] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  // Belt-and-suspenders beyond the AbortController below: httpProvider is the
  // only path guaranteed to actually cancel the network request in flight
  // (tmdbProvider deliberately doesn't — see the note in
  // lib/content/tmdb/index.ts). Comparing `forKey` at render time (below)
  // already prevents a stale response from ever being *shown*; this ref is
  // what stops it from being *applied* to state at all.
  const requestIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const key = resultKey(trimmed, mediaFilter);
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();

    // No setState here in the effect's synchronous body on purpose — react-hooks/
    // set-state-in-effect flags exactly that. "Loading" isn't a separate flag;
    // it's simply "no SearchResult exists yet whose forKey matches the current
    // query/filter" (see the render logic below), which needs no state of its
    // own at all.
    const timer = setTimeout(() => {
      httpProvider
        .searchTitles(trimmed, {
          mediaType: mediaFilter === "all" ? undefined : mediaFilter,
          signal: controller.signal,
        })
        .then((page) => {
          if (requestId !== requestIdRef.current) return;
          setResult({
            forKey: key,
            status: page.items.length === 0 ? "empty" : "results",
            items: page.items,
            errorMessage: null,
          });
        })
        .catch((error) => {
          if (requestId !== requestIdRef.current) return;
          setResult({
            forKey: key,
            status: "error",
            items: [],
            errorMessage:
              error instanceof ContentError
                ? ERROR_COPY[error.kind]
                : ERROR_COPY.unknown,
          });
        });
    }, DEBOUNCE_MS);

    // Cleanup runs BEFORE the next effect fires, so it doubles as "cancel the
    // previous request the instant the query/filter changes" — no separate
    // ref or manual abort call needed for that case. It also covers
    // navigating away from /search entirely.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, mediaFilter, retryNonce]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setQuery("");
  }

  function handleRetry() {
    // A plain event handler, not an effect body — setState here isn't
    // subject to the lint rule above. Clearing the stale result immediately
    // is what makes the retry click show the loading skeleton right away
    // instead of continuing to show the old error until the new attempt
    // resolves; bumping retryNonce is what makes the effect actually re-run,
    // since neither query nor mediaFilter changed.
    setResult(null);
    setRetryNonce((n) => n + 1);
  }

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const currentKey = resultKey(trimmed, mediaFilter);
  const fresh = result !== null && result.forKey === currentKey;

  let content: React.ReactNode;
  if (!hasQuery) {
    content = (
      <EmptyState
        icon={<SearchIcon />}
        title="Find something to watch"
        body="Start typing a title — results appear as you type."
        className="py-14"
      />
    );
  } else if (!fresh) {
    // Covers both the debounce window and the request actually in flight —
    // deliberately the same visual, since the user can't tell the two apart
    // and shouldn't need to.
    content = <SkeletonGrid count={10} label="Searching" className="mt-2" />;
  } else if (result.status === "empty") {
    content = (
      <EmptyState
        icon={<SearchIcon />}
        title="No matches"
        body={`Nothing found for "${trimmed}". Try a different spelling, or remove the media type filter.`}
        className="py-14"
      />
    );
  } else if (result.status === "error") {
    content = (
      <EmptyState
        tone="danger"
        icon={<AlertIcon />}
        title="Search failed"
        body={result.errorMessage ?? ERROR_COPY.unknown}
        className="py-14"
        action={
          <Button variant="outline" onClick={handleRetry}>
            Try again
          </Button>
        }
      />
    );
  } else {
    content = (
      <TitleGrid titles={result.items} label="Search results" className="mt-2" />
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-display text-display-xl text-fg uppercase">
          Search
        </h1>
      </header>

      <div className="relative mt-6 max-w-xl">
        <SearchIcon className="text-fg-subtle pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search for a film or series…"
          aria-label="Search for a film or series"
          className="bg-surface border-line text-fg placeholder:text-fg-subtle text-body-lg h-12 w-full rounded-md border pr-4 pl-10"
        />
      </div>

      <Tabs
        defaultValue="all"
        value={mediaFilter}
        onValueChange={(value) => setMediaFilter(value as MediaFilter)}
        className="mt-6"
      >
        <TabsList label="Filter by media type">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="movie">Films</TabsTrigger>
          <TabsTrigger value="tv">Series</TabsTrigger>
        </TabsList>

        {/* Three panels, not one, so each tab keeps a correctly wired
            aria-labelledby/id pair per the WAI-ARIA pattern — even though all
            three render the identical `content` for whichever filter is
            currently active. TabsPanel returns null for the inactive two, so
            `content` is only ever actually mounted once. */}
        <TabsPanel value="all">{content}</TabsPanel>
        <TabsPanel value="movie">{content}</TabsPanel>
        <TabsPanel value="tv">{content}</TabsPanel>
      </Tabs>
    </div>
  );
}
