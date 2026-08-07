import { cn } from "@/lib/utils/cn";

/**
 * A comment author's identity mark. Reuses the exact visual language
 * `AccountCard` already established for "this is a person, here's their
 * initial" (`bg-accent/15 text-accent`, a ringed circle) rather than
 * inventing a second treatment — a comment thread and the account card are
 * both "here is a user" moments and should read as the same idea.
 *
 * Unlike `initialsFor`'s usual caller (a TITLE name, where "The Godfather"
 * should read as "G" not "TG"), a username has no leading article to strip,
 * so this takes just the first character rather than calling `initialsFor`
 * — a username is a single handle, not a two-word name to abbreviate.
 */
export function CommentAvatar({
  username,
  size = "md",
}: {
  username: string;
  size?: "sm" | "md";
}) {
  const initial = username.slice(0, 1).toUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-accent/15 text-accent font-display flex shrink-0 items-center justify-center rounded-full uppercase",
        size === "sm" ? "size-7 text-meta" : "size-9 text-body-sm",
      )}
    >
      {initial}
    </span>
  );
}
