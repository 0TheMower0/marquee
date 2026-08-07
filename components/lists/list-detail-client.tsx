"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { TicketCard } from "@/components/title/ticket-card";
import { TitleGrid } from "@/components/title/title-grid";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListIcon, XIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import type { TitleSummary } from "@/lib/content/types";
import {
  acceptInviteAction,
  addListItemAction,
  deleteListAction,
  inviteCollaboratorAction,
  removeCollaboratorAction,
  removeListItemAction,
  updateListAction,
  type ListDetail,
  type ListItemEntry,
  type ListVisibility,
} from "@/lib/lists";

import { AddItemSearch, itemKey } from "./add-item-search";
import { AgreementSection } from "./agreement-section";
import { CollaboratorPanel } from "./collaborator-panel";
import { FollowButton } from "./follow-button";
import { ListForm } from "./list-form";
import { MemberAvatar, memberLabel } from "./member-avatar";
import { VisibilityBadge } from "./visibility-badge";

/**
 * The interactive owner of one list, same role `CommentsClient` plays for a
 * comment thread — it holds the local, optimistic-ish view of items and
 * collaborators, and every mutation goes through a Server Action then
 * patches THIS state directly rather than re-fetching the whole list.
 */
export function ListDetailClient({
  initialList,
  viewerId,
}: {
  initialList: ListDetail;
  viewerId: string;
}) {
  const router = useRouter();
  const [list, setList] = useState(initialList);
  const [editing, setEditing] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const existingKeys = new Set(list.items.map((item) => itemKey(item.mediaType, item.titleId)));

  async function handleAdd(title: TitleSummary) {
    const result = await addListItemAction(list.id, title.mediaType, title.id, title);
    if (!result.ok) throw result.message;
    const key = itemKey(title.mediaType, title.id);
    setList((prev) => {
      // Defensive against a double-click racing ahead of the AddItemSearch
      // button's own `already` disable — the action tolerates the duplicate
      // INSERT (23505), but the local list must not grow a second card for it.
      if (prev.items.some((item) => itemKey(item.mediaType, item.titleId) === key)) return prev;
      return {
        ...prev,
        items: [...prev.items, result.data],
        itemCount: prev.itemCount + 1,
      };
    });
  }

  async function handleRemoveItem(item: ListItemEntry) {
    const key = itemKey(item.mediaType, item.titleId);
    setRemovingKey(key);
    setItemError(null);
    const result = await removeListItemAction(list.id, item.mediaType, item.titleId);
    setRemovingKey(null);
    if (!result.ok) {
      setItemError(result.message);
      return;
    }
    setList((prev) => ({
      ...prev,
      items: prev.items.filter((i) => itemKey(i.mediaType, i.titleId) !== key),
      itemCount: Math.max(0, prev.itemCount - 1),
    }));
  }

  async function handleSaveEdit(name: string, description: string, visibility: ListVisibility) {
    const result = await updateListAction(list.id, name, description, visibility);
    if (!result.ok) throw result.message;
    setList((prev) => ({ ...prev, ...result.data }));
    setEditing(false);
  }

  async function handleDelete() {
    if (!confirm(`Delete "${list.name}"? This can't be undone from here.`)) return;
    setDeleting(true);
    const result = await deleteListAction(list.id);
    setDeleting(false);
    if (!result.ok) {
      setItemError(result.message);
      return;
    }
    router.push("/lists");
  }

  async function handleInvite(username: string) {
    const result = await inviteCollaboratorAction(list.id, username);
    if (!result.ok) throw result.message;
    setList((prev) => ({ ...prev, collaborators: [...prev.collaborators, result.data] }));
  }

  async function handleAccept() {
    const result = await acceptInviteAction(list.id);
    if (!result.ok) return;
    setList((prev) => ({
      ...prev,
      collaborators: prev.collaborators.map((c) =>
        c.isSelf ? { ...c, status: "accepted", respondedAt: new Date() } : c,
      ),
      canEdit: true,
    }));
  }

  async function handleRemoveCollaborator(userId: string) {
    const result = await removeCollaboratorAction(list.id, userId);
    if (!result.ok) return;
    if (userId === viewerId) {
      // Left or declined our own membership — nothing left to edit here.
      router.push("/lists");
      return;
    }
    setList((prev) => ({
      ...prev,
      collaborators: prev.collaborators.filter((c) => c.user.id !== userId),
    }));
  }

  if (editing) {
    return (
      <div className="max-w-xl">
        <h1 className="font-display text-display-lg text-fg mb-4 uppercase">Edit list</h1>
        <ListForm
          initialName={list.name}
          initialDescription={list.description ?? ""}
          initialVisibility={list.visibility}
          submitLabel="Save changes"
          onSubmit={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-display-lg text-fg uppercase">{list.name}</h1>
            <VisibilityBadge visibility={list.visibility} />
          </div>
          {list.description && (
            <p className="text-body-sm text-fg-muted mt-2 max-w-prose">{list.description}</p>
          )}
          <div className="text-meta text-fg-subtle mt-2 flex items-center gap-2">
            <MemberAvatar member={list.owner} size="sm" />
            <span>
              {list.isOwn ? "You" : memberLabel(list.owner)} · {list.itemCount} title
              {list.itemCount === 1 ? "" : "s"} · {list.followerCount} follower
              {list.followerCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {list.isOwner ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                isLoading={deleting}
                onClick={() => void handleDelete()}
              >
                Delete
              </Button>
            </>
          ) : (
            !list.canEdit && (
              <FollowButton listId={list.id} initialFollowing={list.isFollowedByViewer} />
            )
          )}
        </div>
      </header>

      {itemError && (
        <p role="alert" className="border-danger/40 bg-danger/10 text-danger rounded-md border px-3 py-2 text-body-sm">
          {itemError}
        </p>
      )}

      {list.canEdit && (
        <CollaboratorPanel
          collaborators={list.collaborators}
          isOwner={list.isOwner}
          onInvite={handleInvite}
          onAccept={handleAccept}
          onRemove={handleRemoveCollaborator}
        />
      )}

      {list.canEdit && list.items.length + list.collaborators.length > 0 && (
        <AgreementSection list={list} />
      )}

      {list.canEdit && (
        <section aria-label="Add a title to this list" className="border-line-subtle rounded-lg border p-4">
          <AddItemSearch existingKeys={existingKeys} onAdd={handleAdd} />
        </section>
      )}

      <section aria-labelledby="list-items-heading">
        <h2 id="list-items-heading" className="font-display text-display-md text-fg uppercase">
          Titles
        </h2>

        {list.items.length === 0 ? (
          <EmptyState
            icon={<ListIcon />}
            title="Nothing here yet"
            body={
              list.canEdit
                ? "Search above to add the first title."
                : "The owner hasn't added anything to this list yet."
            }
            className="py-10"
          />
        ) : list.canEdit ? (
          <ul
            aria-label={`${list.name} titles`}
            className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          >
            {list.items.map((item) => {
              const key = itemKey(item.mediaType, item.titleId);
              return (
                <li key={key} className="group relative">
                  <TicketCard title={item.summary} />
                  {/* Top-LEFT, deliberately — TicketCard already places
                      TrackingBadge top-right (a sibling of its Link, for the
                      same reason: a <button> inside an <a> is invalid HTML).
                      Two absolute-positioned siblings competing for the same
                      corner would overlap and fight for clicks. */}
                  <button
                    type="button"
                    aria-label={`Remove ${item.summary.name} from this list`}
                    disabled={removingKey === key}
                    onClick={() => void handleRemoveItem(item)}
                    className="bg-ink/80 text-fg hover:bg-danger absolute top-2 left-2 z-10 flex size-7 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
                  >
                    <XIcon className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <TitleGrid
            titles={list.items.map((item) => item.summary)}
            label={`${list.name} titles`}
            className="mt-4"
          />
        )}
      </section>
    </div>
  );
}

export function ListDetailSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="bg-overlay h-9 w-64 animate-pulse rounded-sm" />
        <div className="bg-overlay h-4 w-96 animate-pulse rounded-sm" />
      </div>
      <SkeletonGrid count={5} label="Loading list" />
    </div>
  );
}
