"use client";

import { Fragment, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CompassIcon } from "@/components/ui/icons";
import type { HomeSectionId } from "@/lib/home";

import { useHomeConfig } from "./use-home-config";

interface HomeSectionsProps {
  /** One fully-rendered node per section id. Up Next is already a Client
   *  Component; Trending's slot is a Server Component wrapped in its own
   *  Suspense boundary (see app/page.tsx) — this component only decides
   *  WHERE each one sits, never what's inside it, so reordering costs
   *  nothing extra on either side of that boundary. */
  slots: Record<HomeSectionId, ReactNode>;
}

/**
 * Renders Home's reorderable sections in the user's configured order — real
 * DOM order via a plain `.map()`, not CSS `order`, so tab order and
 * screen-reader reading order match what's visually on screen. CSS `order`
 * only moves pixels; it does neither of those.
 *
 * `useHomeConfig()`'s `config` is already `DEFAULT_HOME_CONFIG` before the
 * real value loads (see that hook's own doc comment), so there's no separate
 * loading branch to write here — Home looks exactly as it always has until
 * the stored preference, if any, arrives.
 */
export function HomeSections({ slots }: HomeSectionsProps) {
  const { config } = useHomeConfig();
  const visible = config.sections.filter((section) => section.visible);

  if (visible.length === 0) {
    // "Never blank" — same rule Search's three states and Up Next's own
    // empty state already follow. A user has to deliberately turn off both
    // sections to reach this; it must still say something rather than leave
    // a dead gap under the page header.
    return (
      <EmptyState
        icon={<CompassIcon />}
        title="Nothing to show here"
        body="Every Home section is turned off in Settings."
        className="mt-8 py-8"
        action={
          <Button href="/settings" variant="outline" size="sm">
            Open settings
          </Button>
        }
      />
    );
  }

  return (
    <div className="mt-8 space-y-8">
      {visible.map((section) => (
        <Fragment key={section.id}>{slots[section.id]}</Fragment>
      ))}
    </div>
  );
}
