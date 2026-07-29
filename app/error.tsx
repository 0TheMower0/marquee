"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertIcon } from "@/components/ui/icons";

/**
 * The backstop, not the primary error UI.
 *
 * Expected content failures are caught where they happen and rendered by
 * `ContentErrorState`, which can still see `ContentError.kind`. By the time an
 * error reaches *here* it has crossed the server/client boundary, and Next
 * deliberately strips it to a generic message plus a digest in production so
 * server internals can't leak. So this component cannot say anything specific
 * about what broke, and shouldn't pretend to.
 *
 * Next 16 note: the prop is `unstable_retry`. `reset` was removed — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // No error reporting service yet, so the console is the only trail. The
    // digest is what matches this render to the server-side log entry.
    console.error("Unhandled render error", error);
  }, [error]);

  return (
    <EmptyState
      tone="danger"
      icon={<AlertIcon />}
      title="Something broke"
      body="That's on us, not on you. Retrying re-renders this section from scratch, which clears most transient failures."
      className="min-h-[70vh]"
      action={
        <>
          <Button variant="outline" onClick={() => unstable_retry()}>
            Try again
          </Button>
          <Button href="/" variant="ghost">
            Go home
          </Button>
        </>
      }
    />
  );
}
