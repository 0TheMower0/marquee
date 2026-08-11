import { RetryButton } from "@/components/content/retry-button";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertIcon } from "@/components/ui/icons";
import type { ContentErrorKind } from "@/lib/content/errors";

/**
 * The single place `ContentError.kind` is turned into user-facing copy.
 *
 * This exists because of a real constraint, not for tidiness: **`kind` cannot
 * survive the trip to `error.tsx`.** Next serializes Server Component errors to
 * a generic message plus a digest in production specifically so server details
 * don't leak to the client, so an error boundary can only ever say "something
 * went wrong". Kind-specific UI therefore has to be rendered on the server, by
 * catching `ContentError` at the call site and rendering this component.
 *
 * `error.tsx` still exists and still matters — it is the backstop for anything
 * that *isn't* a ContentError (a genuine bug in render). The two are layers,
 * not alternatives.
 */

interface Copy {
  title: string;
  body: string;
  /** Off where retrying cannot possibly help — a bad token stays bad. */
  retry: boolean;
}

const COPY: Record<ContentErrorKind, Copy> = {
  not_found: {
    title: "Not found",
    body: "We couldn't find that title. It may have been removed, or the link may be wrong.",
    retry: false,
  },
  unauthorized: {
    title: "Content source unavailable",
    // Says nothing about env vars or file paths. This is a SERVER
    // misconfiguration — our credential, not the reader's — so naming
    // `TMDB_READ_ACCESS_TOKEN` and `.env.local` (as this used to) put setup
    // instructions in front of a visitor who cannot act on them and did
    // nothing wrong. The operator sees the real cause in the server log,
    // where `handleRouteError` already logs the upstream message; the same
    // split CLAUDE.md documents for API responses applies to rendered copy.
    body: "We can't load titles right now. This is a problem on our end, not yours — it should be back shortly.",
    retry: false,
  },
  rate_limited: {
    title: "Too many requests",
    body: "The content source is rate limiting us right now. Give it a moment and try again.",
    retry: true,
  },
  network: {
    title: "Couldn't reach the content source",
    body: "The request timed out or the connection dropped. This is usually temporary.",
    retry: true,
  },
  unknown: {
    title: "Something went wrong",
    body: "We couldn't load this right now. Trying again often clears it.",
    retry: true,
  },
};

export function ContentErrorState({
  kind,
  className,
}: {
  kind: ContentErrorKind;
  className?: string;
}) {
  const copy = COPY[kind];

  return (
    <EmptyState
      tone="danger"
      icon={<AlertIcon />}
      title={copy.title}
      body={copy.body}
      className={className}
      action={
        <>
          {copy.retry && <RetryButton />}
          <Button href="/" variant="ghost">
            Go home
          </Button>
        </>
      }
    />
  );
}
