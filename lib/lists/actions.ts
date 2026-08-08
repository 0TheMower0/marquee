"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import type { TitleSummary } from "@/lib/content/types";
import { RATE_LIMITS, checkRateLimit } from "@/lib/ratelimit";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

import { ListError, listErrorMessage, mapListError } from "./errors";
import { getAgreementItems, getListDetail } from "./queries";
import type {
  CollaboratorStatus,
  ListCollaborator,
  ListDetail,
  ListItemEntry,
  ListSummary,
} from "./types";
import {
  isListVisibility,
  validateListDescription,
  validateListName,
} from "./validate";
import {
  rowToCollaborator,
  rowToListItem,
  rowToListSummary,
  type ListCollaboratorRow,
} from "./wire";

/**
 * Server Actions — the client seam for lists, the identical shape
 * `lib/comments/actions.ts` established: plain async functions returning a
 * discriminated result, called directly from client event handlers (not
 * `useActionState`), because the caller owns exactly where a mutation's
 * result goes in local state — append to a list, replace an item in place,
 * remove a roster row.
 *
 * ============================================================================
 * THE ONE RULE EVERY INSERT BELOW FOLLOWS, LEARNED THE HARD WAY IN STEP 6A
 * ============================================================================
 * `postCommentAction` and `reportCommentAction` both once omitted their
 * owner-id column. Neither failed as a missing-field error — comparing NULL
 * against `auth.uid()` in an INSERT policy's `WITH CHECK` is never TRUE, so
 * both read as an ordinary-looking `forbidden` rejection and sent debugging
 * toward the gating logic for a real stretch before the actual bug was found.
 * Every insert below sets its owner-ish column (`owner_id`, `added_by`,
 * `invited_by`, `user_id`) EXPLICITLY, every time, on purpose.
 */

const TOO_MANY = "Slow down a little — try again in a minute.";

async function rateLimitCheck(rule: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS]) {
  const requestHeaders = await headers();
  const decision = await checkRateLimit(
    new Request("http://server-action.local", { headers: requestHeaders }),
    rule,
  );
  return decision.allowed;
}

function configuredOrThrow(): void {
  if (!isSupabaseConfigured()) {
    throw new ListError("not_configured", "Supabase is not configured.");
  }
}

async function requireViewerId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ListError("not_authenticated", "no session");
  return data.user.id;
}

export type ListActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** Kinds a well-behaved client should never trigger through normal use — same
 *  narrow, deliberate logging `lib/comments/actions.ts`'s `failure()` uses,
 *  added there specifically because it was what finally surfaced the missing
 *  `user_id` bug this file's header comment describes. */
const UNEXPECTED_KINDS = new Set(["forbidden", "unknown", "network"]);

function failure<T>(error: unknown): ListActionResult<T> {
  const mapped = mapListError(error);
  if (UNEXPECTED_KINDS.has(mapped.kind)) {
    console.error("[lists] unexpected action failure:", mapped.message);
  }
  return { ok: false, message: listErrorMessage(mapped) };
}

const SUMMARY_COLUMNS = `
  id, owner_id, name, description, visibility, created_at, updated_at, deleted_at,
  owner:profiles!lists_owner_id_fkey ( username, display_name ),
  list_items ( count )
`;

/**
 * A SEPARATE statement from whatever write preceded it — never chain
 * `.select()` onto an `.insert()`/`.update()` for `lists` and call this
 * instead. Found live, not in review: Postgres applies the SELECT policy's
 * USING clause to a RETURNING row, and `lists_select_visible` calls
 * `can_view_list()`, which re-queries `public.lists` for the row BY ID. For
 * a fresh INSERT, that re-query runs inside the same command that is still
 * creating the row, and the row is not yet visible to it — so RETURNING
 * fails RLS on a list you unquestionably own, with the exact same
 * `42501`/"new row violates row-level security policy" wording an ordinary
 * WITH CHECK failure produces. Confirmed directly against the live
 * database: `can_view_list(id)` called as its own statement immediately
 * after an equivalent insert returns `true`; the identical insert with
 * `.select().single()` chained on fails. `can_view_comment_scope` (Step 6a)
 * never hit this — it checks OTHER, already-committed tables
 * (`watched_episodes`/`tracked_titles`), never the `comments` table it is
 * itself gating. `list_items`/`list_collaborators` don't hit it either:
 * their SELECT policies call `can_view_list`/`can_edit_list` against
 * `lists`, a DIFFERENT table that already existed before this command. Only
 * `lists` itself is self-referential this way, which is why only
 * `createListAction` needed its id generated up front instead of taken from
 * RETURNING — see the `randomUUID()` call there.
 */
async function reselectSummary(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  listId: string,
  viewerId: string,
): Promise<ListSummary> {
  const { data, error } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .eq("id", listId)
    .maybeSingle();
  if (error) throw mapListError(error);
  if (!data) throw new ListError("not_found", "list vanished after write");

  const row = data as unknown as { list_items: { count: number }[] } & Parameters<
    typeof rowToListSummary
  >[0];

  const { data: counts, error: countError } = await supabase.rpc("list_follower_counts", {
    p_list_ids: [listId],
  });
  if (countError) throw mapListError(countError);
  const followerCount =
    ((counts ?? []) as { list_id: string; followers: number }[])[0]?.followers ?? 0;

  return rowToListSummary(row, viewerId, row.list_items[0]?.count ?? 0, followerCount);
}

/* ---------------------------------------------------------------------------
 * Create / update / delete
 * ------------------------------------------------------------------------ */

export async function createListAction(
  name: string,
  description: string,
  visibility: string,
): Promise<ListActionResult<ListSummary>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.lists))) return { ok: false, message: TOO_MANY };

    const checkedName = validateListName(name);
    if (!checkedName.ok) return { ok: false, message: "Give the list a name." };
    const checkedDescription = validateListDescription(description);
    if (!checkedDescription.ok) {
      return { ok: false, message: "That description is too long." };
    }
    if (!isListVisibility(visibility)) {
      return { ok: false, message: "Choose a visibility." };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // The id is generated HERE, not left to the column default, specifically
    // so this insert never needs `.select()`/RETURNING chained onto it — see
    // the long comment above `reselectSummary` for why that combination is
    // broken for this one table.
    const id = randomUUID();
    const { error } = await supabase.from("lists").insert({
      id,
      owner_id: viewerId,
      name: checkedName.value,
      description: checkedDescription.value,
      visibility,
    });

    if (error) throw mapListError(error);

    return { ok: true, data: await reselectSummary(supabase, id, viewerId) };
  } catch (error) {
    return failure(error);
  }
}

export async function updateListAction(
  listId: string,
  name: string,
  description: string,
  visibility: string,
): Promise<ListActionResult<ListSummary>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.lists))) return { ok: false, message: TOO_MANY };

    const checkedName = validateListName(name);
    if (!checkedName.ok) return { ok: false, message: "Give the list a name." };
    const checkedDescription = validateListDescription(description);
    if (!checkedDescription.ok) {
      return { ok: false, message: "That description is too long." };
    }
    if (!isListVisibility(visibility)) {
      return { ok: false, message: "Choose a visibility." };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // `lists_update_own` restricts this to the OWNER's own row — a
    // collaborator hitting this action gets zero rows affected, reported
    // honestly as not_found (see the identical reasoning in
    // lib/comments/actions.ts's editCommentAction).
    const { data, error } = await supabase
      .from("lists")
      .update({
        name: checkedName.value,
        description: checkedDescription.value,
        visibility,
      })
      .eq("id", listId)
      .select("id")
      .maybeSingle();

    if (error) throw mapListError(error);
    if (!data) throw new ListError("not_found", "list not found or not yours to edit");

    return { ok: true, data: await reselectSummary(supabase, listId, viewerId) };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteListAction(listId: string): Promise<ListActionResult<{ id: string }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.lists))) return { ok: false, message: TOO_MANY };

    const supabase = await createSupabaseServerClient();
    await requireViewerId(supabase);

    const { data, error } = await supabase
      .from("lists")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", listId)
      .select("id")
      .maybeSingle();

    if (error) throw mapListError(error);
    if (!data) throw new ListError("not_found", "list not found or not yours to delete");

    return { ok: true, data: { id: listId } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Items
 * ------------------------------------------------------------------------ */

export async function addListItemAction(
  listId: string,
  mediaType: string,
  titleId: string,
  summary: TitleSummary,
): Promise<ListActionResult<ListItemEntry>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listItems))) return { ok: false, message: TOO_MANY };
    if (mediaType !== "movie" && mediaType !== "tv") {
      return { ok: false, message: "Invalid title." };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    const { error } = await supabase.from("list_items").insert({
      list_id: listId,
      media_type: mediaType,
      title_id: titleId,
      summary,
      added_by: viewerId,
    });

    if (error) {
      const mapped = mapListError(error);
      // Already on the list — an ordinary outcome (double-click, two tabs),
      // not a failure, same as a duplicate comment report.
      if ((error as { code?: string }).code === "23505") {
        return {
          ok: true,
          data: { mediaType, titleId, summary, addedBy: null, addedAt: new Date() },
        };
      }
      throw mapped;
    }

    const { data, error: reselectError } = await supabase
      .from("list_items")
      .select(
        `list_id, media_type, title_id, summary, added_by, added_at,
         adder:profiles!list_items_added_by_fkey ( username, display_name )`,
      )
      .eq("list_id", listId)
      .eq("media_type", mediaType)
      .eq("title_id", titleId)
      .single();
    if (reselectError) throw mapListError(reselectError);

    return { ok: true, data: rowToListItem(data as never) };
  } catch (error) {
    return failure(error);
  }
}

export async function removeListItemAction(
  listId: string,
  mediaType: string,
  titleId: string,
): Promise<ListActionResult<{ titleId: string }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listItems))) return { ok: false, message: TOO_MANY };

    const supabase = await createSupabaseServerClient();
    await requireViewerId(supabase);

    const { error } = await supabase
      .from("list_items")
      .delete()
      .eq("list_id", listId)
      .eq("media_type", mediaType)
      .eq("title_id", titleId);

    if (error) throw mapListError(error);
    return { ok: true, data: { titleId } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Collaborators
 * ------------------------------------------------------------------------ */

export async function inviteCollaboratorAction(
  listId: string,
  username: string,
): Promise<ListActionResult<ListCollaborator>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listCollaborators))) {
      return { ok: false, message: TOO_MANY };
    }

    const trimmed = username.trim();
    if (trimmed.length === 0) return { ok: false, message: "Enter a username." };

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // profiles is readable by any authenticated user (Phase 6 Step 4), so
    // this lookup needs no special privilege — it is the same lookup the
    // sign-up form's availability check uses, just inverted (does this name
    // belong to someone, rather than does it belong to nobody).
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .ilike("username", trimmed)
      .maybeSingle();
    if (profileError) throw mapListError(profileError);
    if (!profile) return { ok: false, message: "No account with that username." };

    if (profile.id === viewerId) {
      return { ok: false, message: "You already own this list." };
    }

    const { error } = await supabase.from("list_collaborators").insert({
      list_id: listId,
      user_id: profile.id,
      invited_by: viewerId,
    });

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, message: "Already invited." };
      }
      throw mapListError(error);
    }

    const { data, error: reselectError } = await supabase
      .from("list_collaborators")
      .select(
        `list_id, user_id, invited_by, status, invited_at, responded_at,
         member:profiles!list_collaborators_user_id_fkey ( username, display_name ),
         inviter:profiles!list_collaborators_invited_by_fkey ( username, display_name )`,
      )
      .eq("list_id", listId)
      .eq("user_id", profile.id)
      .single();
    if (reselectError) throw mapListError(reselectError);

    return { ok: true, data: rowToCollaborator(data as unknown as ListCollaboratorRow, viewerId) };
  } catch (error) {
    return failure(error);
  }
}

/** Accept an invite. Declining is `removeCollaboratorAction` instead — see
 *  the migration's note on why a decline is a DELETE, not a status. */
export async function acceptInviteAction(
  listId: string,
): Promise<ListActionResult<{ status: CollaboratorStatus }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listCollaborators))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    const { data, error } = await supabase
      .from("list_collaborators")
      .update({ status: "accepted" })
      .eq("list_id", listId)
      .eq("user_id", viewerId)
      .select("status")
      .maybeSingle();

    if (error) throw mapListError(error);
    if (!data) throw new ListError("not_found", "invite not found");

    return { ok: true, data: { status: "accepted" } };
  } catch (error) {
    return failure(error);
  }
}

/** Removes a collaborator row outright — used for BOTH declining a pending
 *  invite and leaving/being removed from an accepted collaboration. RLS
 *  (`list_collaborators_delete_self_or_owner`) is what actually decides
 *  whether `targetUserId` may differ from the caller: it may, only if the
 *  caller is the list's owner. */
export async function removeCollaboratorAction(
  listId: string,
  targetUserId: string,
): Promise<ListActionResult<{ userId: string }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listCollaborators))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    await requireViewerId(supabase);

    const { error } = await supabase
      .from("list_collaborators")
      .delete()
      .eq("list_id", listId)
      .eq("user_id", targetUserId);

    if (error) throw mapListError(error);
    return { ok: true, data: { userId: targetUserId } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Following
 * ------------------------------------------------------------------------ */

export async function followListAction(
  listId: string,
): Promise<ListActionResult<{ following: true }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listFollowers))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    const { error } = await supabase
      .from("list_followers")
      .upsert({ list_id: listId, user_id: viewerId }, { onConflict: "list_id,user_id" });
    if (error) throw mapListError(error);

    return { ok: true, data: { following: true } };
  } catch (error) {
    return failure(error);
  }
}

export async function unfollowListAction(
  listId: string,
): Promise<ListActionResult<{ following: false }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.listFollowers))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    const { error } = await supabase
      .from("list_followers")
      .delete()
      .eq("list_id", listId)
      .eq("user_id", viewerId);
    if (error) throw mapListError(error);

    return { ok: true, data: { following: false } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * On-demand fetch — the client seam into lib/lists/queries.ts, which is
 * server-only and unreachable directly from a Client Component.
 * ------------------------------------------------------------------------ */

export async function fetchListDetailAction(
  listId: string,
): Promise<ListActionResult<ListDetail | null>> {
  try {
    configuredOrThrow();
    return { ok: true, data: await getListDetail(listId) };
  } catch (error) {
    return failure(error);
  }
}

export async function fetchAgreementAction(
  list: ListDetail,
): Promise<ListActionResult<ListItemEntry[]>> {
  try {
    configuredOrThrow();
    return { ok: true, data: await getAgreementItems(list) };
  } catch (error) {
    return failure(error);
  }
}
