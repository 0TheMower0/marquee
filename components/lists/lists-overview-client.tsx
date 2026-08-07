"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon, ListIcon, UsersIcon } from "@/components/ui/icons";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import type { ListSummary } from "@/lib/lists";

import { ListCardGrid } from "./list-card";

const TABS: {
  value: string;
  label: string;
  emptyIcon: typeof ListIcon;
  emptyTitle: string;
  emptyBody: string;
}[] = [
  {
    value: "mine",
    label: "My Lists",
    emptyIcon: ListIcon,
    emptyTitle: "No lists yet",
    emptyBody: "Create one to start tracking what you're planning to watch together.",
  },
  {
    value: "collaborating",
    label: "Collaborating",
    emptyIcon: UsersIcon,
    emptyTitle: "Not collaborating on anything yet",
    emptyBody: "Lists you accept an invite to will show up here.",
  },
  {
    value: "following",
    label: "Following",
    emptyIcon: CompassIcon,
    emptyTitle: "Not following any lists yet",
    emptyBody: "Follow a public list from Discover to keep an eye on it.",
  },
  {
    value: "discover",
    label: "Discover",
    emptyIcon: CompassIcon,
    emptyTitle: "No public lists yet",
    emptyBody: "Public lists other people create will show up here.",
  },
];

export function ListsOverviewClient({
  mine,
  collaborating,
  following,
  discover,
}: {
  mine: ListSummary[];
  collaborating: ListSummary[];
  following: ListSummary[];
  discover: ListSummary[];
}) {
  const byTab: Record<string, ListSummary[]> = { mine, collaborating, following, discover };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-display-lg text-fg uppercase">Lists</h1>
        <Button href="/lists/new">New list</Button>
      </div>

      <Tabs defaultValue="mine" className="mt-6">
        <TabsList label="List collections">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label} ({byTab[tab.value].length})
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((tab) => {
          const items = byTab[tab.value];
          return (
            <TabsPanel key={tab.value} value={tab.value}>
              {items.length === 0 ? (
                <EmptyState
                  icon={<tab.emptyIcon />}
                  title={tab.emptyTitle}
                  body={tab.emptyBody}
                  className="py-12"
                  action={
                    tab.value === "mine" ? (
                      <Button href="/lists/new" variant="outline" size="sm">
                        New list
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ListCardGrid lists={items} />
              )}
            </TabsPanel>
          );
        })}
      </Tabs>
    </div>
  );
}
