"use client";

import { useState } from "react";

import type { PendingInvite } from "@/lib/lists";

import { PendingInviteRow } from "./pending-invite-row";

export function PendingInvitesClient({
  initialInvites,
  viewerId,
}: {
  initialInvites: PendingInvite[];
  viewerId: string;
}) {
  const [invites, setInvites] = useState(initialInvites);

  if (invites.length === 0) return null;

  return (
    <section aria-labelledby="pending-invites-heading" className="space-y-3">
      <h2 id="pending-invites-heading" className="font-display text-display-md text-fg uppercase">
        List invites
      </h2>
      <ul className="space-y-2">
        {invites.map((invite) => (
          <PendingInviteRow
            key={invite.list.id}
            invite={invite}
            viewerId={viewerId}
            onResolved={(listId) =>
              setInvites((prev) => prev.filter((i) => i.list.id !== listId))
            }
          />
        ))}
      </ul>
    </section>
  );
}
