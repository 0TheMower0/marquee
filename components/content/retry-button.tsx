"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

/**
 * `router.refresh()` re-runs the Server Component render for the current route
 * — which is exactly what a retry means when the failure was a provider fetch.
 * A plain `location.reload()` would also work but throws away the whole client
 * state tree and the app shell along with it.
 *
 * Wrapped in useTransition so the button can show a pending state; without it
 * the refresh is invisible and an impatient user hammers the button.
 */
export function RetryButton({ children = "Try again" }: { children?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      isLoading={isPending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {children}
    </Button>
  );
}
