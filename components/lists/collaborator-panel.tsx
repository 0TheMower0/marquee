"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { UsersIcon, XIcon } from "@/components/ui/icons";
import type { ListCollaborator } from "@/lib/lists";
import { cn } from "@/lib/utils/cn";

import { MemberAvatar, memberLabel } from "./member-avatar";

/**
 * The roster + invite form. Only ever rendered for the owner or an accepted
 * collaborator — `getListDetail` doesn't even populate `collaborators` for
 * anyone else, so there is no "you can't see this" branch to write here.
 */
export function CollaboratorPanel({
  collaborators,
  isOwner,
  onInvite,
  onAccept,
  onRemove,
}: {
  collaborators: ListCollaborator[];
  isOwner: boolean;
  /** REJECTS with a user-facing message string on failure. */
  onInvite: (username: string) => Promise<void>;
  onAccept: () => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function submitInvite() {
    const trimmed = username.trim();
    if (!trimmed || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      await onInvite(trimmed);
      setUsername("");
    } catch (message) {
      setInviteError(typeof message === "string" ? message : "Couldn't send that invite.");
    } finally {
      setInviting(false);
    }
  }

  async function withPending(key: string, action: () => Promise<void>) {
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="font-display text-display-sm text-fg flex items-center gap-2 uppercase">
        <UsersIcon className="size-4" /> Collaborators
      </h3>

      {isOwner && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitInvite();
              }}
              placeholder="Invite by username"
              aria-label="Invite by username"
              className="bg-ink border-line text-fg placeholder:text-fg-subtle h-9 flex-1 rounded-md border px-3 text-body-sm"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              isLoading={inviting}
              disabled={username.trim().length === 0}
              onClick={() => void submitInvite()}
            >
              Invite
            </Button>
          </div>
          {inviteError && (
            <p role="alert" className="text-meta text-danger">
              {inviteError}
            </p>
          )}
        </div>
      )}

      {collaborators.length === 0 ? (
        <p className="text-meta text-fg-subtle">No collaborators yet.</p>
      ) : (
        <ul className="space-y-2">
          {collaborators.map((collaborator) => {
            const key = collaborator.user.id;
            const isPending = pendingAction === key;
            const canRemove = isOwner || collaborator.isSelf;

            return (
              <li key={key} className="flex items-center gap-3">
                <MemberAvatar member={collaborator.user} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-fg truncate">
                    {collaborator.isSelf ? "You" : memberLabel(collaborator.user)}
                  </p>
                  <p
                    className={cn(
                      "text-meta",
                      collaborator.status === "invited" ? "text-warning" : "text-fg-subtle",
                    )}
                  >
                    {collaborator.status === "invited" ? "Invited" : "Collaborator"}
                  </p>
                </div>

                {collaborator.isSelf && collaborator.status === "invited" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    isLoading={isPending}
                    onClick={() => void withPending(key, onAccept)}
                  >
                    Accept
                  </Button>
                )}

                {canRemove && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={
                      collaborator.isSelf
                        ? collaborator.status === "invited"
                          ? "Decline invite"
                          : "Leave list"
                        : `Remove ${memberLabel(collaborator.user)}`
                    }
                    isLoading={isPending}
                    onClick={() => void withPending(key, () => onRemove(collaborator.user.id))}
                  >
                    <XIcon className="size-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
