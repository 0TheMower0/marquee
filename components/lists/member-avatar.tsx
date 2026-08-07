import type { ListMember } from "@/lib/lists";
import { cn } from "@/lib/utils/cn";

/**
 * Same visual language `CommentAvatar` established (ringed circle, initial
 * letter, `bg-accent/15 text-accent`) — a list owner/collaborator/follower is
 * the same "here is a person" moment a comment author is, so it should read
 * as the same idea rather than inventing a second treatment.
 *
 * Takes a `ListMember | null` directly (not just a username) because a
 * removed account is a real, reachable state here — `list_items.added_by`
 * and `list_collaborators.invited_by` are both `on delete set null` — and
 * every call site already has the member object in hand, not a bare string.
 */
export function MemberAvatar({
  member,
  size = "md",
}: {
  member: ListMember | null;
  size?: "sm" | "md";
}) {
  const label = member?.displayName || member?.username || "Deleted user";
  const initial = (member?.username.slice(0, 1) || "?").toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-accent/15 text-accent font-display flex shrink-0 items-center justify-center rounded-full uppercase",
        size === "sm" ? "size-7 text-meta" : "size-9 text-body-sm",
      )}
      title={label}
    >
      {initial}
    </span>
  );
}

export function memberLabel(member: ListMember | null): string {
  if (!member) return "Deleted user";
  return member.displayName || `@${member.username}`;
}
