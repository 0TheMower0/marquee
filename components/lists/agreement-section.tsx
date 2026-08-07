"use client";

import { useState } from "react";

import { TitleGrid } from "@/components/title/title-grid";
import { Button } from "@/components/ui/button";
import { EyeIcon, SpinnerIcon } from "@/components/ui/icons";
import { fetchAgreementAction, type ListDetail, type ListItemEntry } from "@/lib/lists";

/**
 * "What can we all agree on" — computed on demand rather than on every list
 * load. Only relevant once a list actually has more than one member, and the
 * query (a cross-user `tracked_titles` read plus the pure filter) is real
 * enough work that running it unconditionally on every visit to every list
 * — including the vast majority that are solo — would be wasted cost. A
 * button makes the cost visible instead of hidden inside page load.
 */
export function AgreementSection({ list }: { list: ListDetail }) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "done"; items: ListItemEntry[] }
  >({ status: "idle" });

  const memberCount =
    1 + list.collaborators.filter((c) => c.status === "accepted").length;

  async function run() {
    setState({ status: "loading" });
    const result = await fetchAgreementAction(list);
    if (!result.ok) {
      setState({ status: "error", message: result.message });
      return;
    }
    setState({ status: "done", items: result.data });
  }

  return (
    <div className="border-accent/25 bg-accent/8 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-display-sm text-fg flex items-center gap-2 uppercase">
            <EyeIcon className="size-4" /> What can we all agree on?
          </h3>
          <p className="text-meta text-fg-subtle mt-1 max-w-prose">
            {memberCount > 1
              ? "Titles on this list everyone has watchlisted, and nobody has watched yet."
              : "Invite a collaborator to see what you both haven't watched yet."}
          </p>
        </div>
        {state.status !== "done" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            isLoading={state.status === "loading"}
            onClick={() => void run()}
          >
            {state.status === "loading" ? (
              <>
                <SpinnerIcon className="size-4 motion-safe:animate-spin" /> Checking…
              </>
            ) : (
              "Check agreement"
            )}
          </Button>
        )}
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-meta text-danger mt-3">
          {state.message}
        </p>
      )}

      {state.status === "done" && (
        state.items.length === 0 ? (
          <p className="text-meta text-fg-subtle mt-3">
            Nothing everyone agrees on yet — add more titles, or watchlist the ones already here.
          </p>
        ) : (
          <div className="mt-4">
            <TitleGrid
              titles={state.items.map((item) => item.summary)}
              label="Titles everyone agrees on"
            />
          </div>
        )
      )}
    </div>
  );
}
