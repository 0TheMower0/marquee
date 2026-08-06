"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertIcon, CheckIcon, SpinnerIcon } from "@/components/ui/icons";
import { useSync } from "@/lib/sync";
import { cn } from "@/lib/utils/cn";

/**
 * The sync status surface.
 *
 * ============================================================================
 * WHY THIS IS LOUD ABOUT FAILURE AND QUIET ABOUT SUCCESS
 * ============================================================================
 * The brief: "Sync failures must be visible to the user, not silent. Someone
 * who thinks they're synced and isn't will lose data eventually."
 *
 * So the three states are deliberately asymmetric:
 *
 *   - **idle** — a small, calm line. Success is the expected case and does not
 *     deserve an alert; a permanent green banner trains people to ignore the
 *     spot where the red one will appear.
 *   - **offline** — informational, never alarming. Queued writes are the
 *     system working as designed, and the local replica is complete. Framing
 *     this as an error would make normal offline use feel broken.
 *   - **error** — `role="alert"`, danger tokens, an explicit retry, and copy
 *     that says plainly what is and is not at risk. This is the only state
 *     that will not fix itself.
 *
 * Every state also states where the data actually is, because the honest
 * reassurance ("it's on this device") is the thing that makes the warning
 * believable rather than frightening.
 */
export function SyncStatusCard() {
  const sync = useSync();

  // No provider, or signed out. Nothing to report — and saying "not syncing"
  // to someone who never asked for sync would be noise.
  if (!sync || !sync.userId) return null;

  const { phase, pending, stuck, lastSyncedAt, message, syncNow } = sync;

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <SyncBadge />
      </CardHeader>

      <CardBody className="space-y-3">
        {phase === "error" && (
          <div
            role="alert"
            className="border-danger/40 bg-danger/10 text-danger space-y-2 rounded-md border px-3 py-2"
          >
            <p className="text-body-sm font-medium">
              Your changes aren&rsquo;t reaching the server.
            </p>
            <p className="text-meta">
              {message ?? "Sync is failing."} Everything you&rsquo;ve tracked is
              still safe on this device — but it is not backed up to your
              account, and another device won&rsquo;t see it.
            </p>
          </div>
        )}

        {phase === "offline" && (
          <p className="text-body-sm text-fg-muted">
            Offline. {pending === 1 ? "One change is" : `${pending} changes are`}{" "}
            queued and will sync when the connection returns. Nothing is lost in
            the meantime.
          </p>
        )}

        {phase === "idle" && pending === 0 && (
          <p className="text-body-sm text-fg-muted">
            Everything on this device is synced to your account.
          </p>
        )}

        {phase === "idle" && pending > 0 && (
          <p className="text-body-sm text-fg-muted">
            {pending === 1 ? "One change is" : `${pending} changes are`} waiting
            to sync.
          </p>
        )}

        {phase === "syncing" && (
          <p className="text-body-sm text-fg-muted">Syncing…</p>
        )}

        {stuck > 0 && phase !== "error" && (
          <p className="text-meta text-fg-subtle">
            {stuck === 1 ? "One change has" : `${stuck} changes have`} failed
            several times and will keep retrying.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={phase === "error" ? "primary" : "secondary"}
            size="sm"
            onClick={() => void syncNow()}
            isLoading={phase === "syncing"}
          >
            Sync now
          </Button>
          {lastSyncedAt && (
            <span className="text-meta text-fg-subtle">
              Last synced {formatRelative(lastSyncedAt)}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/** The compact indicator, for placements with no room for prose. Renders
 *  nothing in the healthy states, so it can sit anywhere without becoming
 *  permanent furniture. */
export function SyncBadge() {
  const sync = useSync();
  if (!sync || !sync.userId) return null;

  if (sync.phase === "error") {
    return (
      <Badge variant="danger" className="gap-1">
        <AlertIcon className="size-3.5" />
        Not synced
      </Badge>
    );
  }

  if (sync.phase === "offline") {
    return (
      <Badge variant="neutral" className="gap-1">
        Offline
      </Badge>
    );
  }

  if (sync.phase === "syncing") {
    return (
      <Badge variant="neutral" className="gap-1">
        <SpinnerIcon className="size-3.5 motion-safe:animate-spin" />
        Syncing
      </Badge>
    );
  }

  if (sync.pending > 0) {
    return <Badge variant="neutral">{sync.pending} pending</Badge>;
  }

  return (
    <Badge variant="neutral" className={cn("gap-1")}>
      <CheckIcon className="size-3.5" />
      Synced
    </Badge>
  );
}

function formatRelative(when: Date): string {
  const seconds = Math.round((Date.now() - when.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return when.toLocaleDateString();
}
