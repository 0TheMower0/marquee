"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { acceptInviteAction, removeCollaboratorAction, type PendingInvite } from "@/lib/lists";

import { memberLabel } from "./member-avatar";

export function PendingInviteRow({
  invite,
  viewerId,
  onResolved,
}: {
  invite: PendingInvite;
  /** `removeCollaboratorAction` targets a user id, not "me" — declining is
   *  removing the viewer's OWN roster row, so the viewer's id has to be
   *  passed explicitly even though RLS would reject any other id anyway. */
  viewerId: string;
  /** Called once the invite is accepted or declined, so the caller can drop
   *  the row without a second fetch. */
  onResolved: (listId: string) => void;
}) {
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(action: "accept" | "decline") {
    setPending(action);
    setError(null);
    const result =
      action === "accept"
        ? await acceptInviteAction(invite.list.id)
        : await removeCollaboratorAction(invite.list.id, viewerId);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onResolved(invite.list.id);
  }

  return (
    <li className="border-line-subtle flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <p className="text-body-sm text-fg">
          <Link href={`/lists/${invite.list.id}`} className="hover:text-accent underline-offset-2 hover:underline">
            {invite.list.name}
          </Link>
        </p>
        <p className="text-meta text-fg-subtle">
          Invited by {invite.invitedBy ? memberLabel(invite.invitedBy) : "someone who's since left"}
        </p>
        {error && (
          <p role="alert" className="text-meta text-danger mt-1">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          isLoading={pending === "accept"}
          onClick={() => void respond("accept")}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          isLoading={pending === "decline"}
          onClick={() => void respond("decline")}
        >
          Decline
        </Button>
      </div>
    </li>
  );
}
