"use client";

import { useState } from "react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { useSync } from "@/lib/sync";
import { cn } from "@/lib/utils/cn";

import { useSecureContext, useStorageStatus } from "./use-storage-status";

/**
 * A plain readout of the things that silently change how this app behaves on
 * one device and not another.
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL
 * ============================================================================
 * A live two-device test produced "tracking buttons are greyed out and My
 * Library is empty" on a phone, working fine on a desktop, and there was no
 * way from inside the app to tell whether that was blocked storage, a failed
 * sync, an insecure origin, or genuinely having no data. Every one of those
 * looks identical from the outside and needs a completely different fix.
 *
 * So this reports facts rather than a verdict. It lives on the Profile page,
 * NOT on /account: the whole point is diagnosing a device where things are
 * broken, and /account requires a working session — which is one of the things
 * that might be broken.
 *
 * Collapsed by default. It is not something anyone should have to look at, but
 * when they do it must be one tap away and not require a console — phones do
 * not have one.
 */
export function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const storage = useStorageStatus();
  const secure = useSecureContext();
  const sync = useSync();

  const rows: Array<{ label: string; value: string; bad?: boolean; note?: string }> = [
    {
      label: "Storage",
      value:
        storage === "persistent"
          ? "Saving normally"
          : storage === "memory"
            ? "Blocked — this tab only"
            : "Not available",
      bad: storage !== "persistent",
      note:
        storage === "memory"
          ? "Anything you track will be lost when this tab closes. Usually private browsing or a blocked-site-data setting."
          : undefined,
    },
    {
      label: "Secure context",
      value: secure === null ? "Unknown" : secure ? "Yes" : "No (plain HTTP)",
      bad: secure === false,
      note:
        secure === false
          ? "Reached over http:// rather than https:// or localhost. Some browser APIs are switched off here."
          : undefined,
    },
    {
      label: "Account",
      value: sync?.userId ? "Signed in" : "Signed out",
    },
    {
      label: "Sync",
      value:
        !sync || !sync.userId
          ? "Not syncing (local only)"
          : sync.phase === "error"
            ? "Failing"
            : sync.phase === "offline"
              ? "Offline — changes queued"
              : sync.phase === "syncing"
                ? "In progress"
                : "Up to date",
      bad: sync?.phase === "error",
      note: sync?.phase === "error" ? (sync.message ?? undefined) : undefined,
    },
    {
      label: "Waiting to sync",
      value: sync?.userId ? String(sync.pending) : "—",
      bad: (sync?.stuck ?? 0) > 0,
    },
  ];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-body-sm text-fg-subtle hover:text-fg underline"
      >
        Something not working? Check diagnostics
      </button>
    );
  }

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-meta text-fg-subtle hover:text-fg underline"
        >
          Hide
        </button>
      </CardHeader>
      <CardBody>
        <dl className="divide-line-subtle divide-y">
          {rows.map((row) => (
            <div key={row.label} className="py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="text-body-sm text-fg-muted">{row.label}</dt>
                <dd
                  className={cn(
                    "text-body-sm",
                    row.bad ? "text-danger font-medium" : "text-fg",
                  )}
                >
                  {row.value}
                </dd>
              </div>
              {row.note && <p className="text-meta text-fg-subtle mt-1">{row.note}</p>}
            </div>
          ))}
        </dl>

        <p className="text-meta text-fg-subtle mt-4">
          Marquee always reads from this device first, so a sync problem never
          means your library is gone — only that this device and your account
          haven&rsquo;t caught up with each other.
        </p>
      </CardBody>
    </Card>
  );
}
