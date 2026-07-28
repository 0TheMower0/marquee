import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertIcon,
  BookmarkIcon,
  CheckIcon,
  CompassIcon,
  FilmIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TvIcon,
} from "@/components/ui/icons";
import {
  Skeleton,
  SkeletonGrid,
  SkeletonText,
  TicketCardSkeleton,
} from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { TicketCard } from "@/components/title/ticket-card";
import type { TitleSummary } from "@/lib/content/types";

/**
 * TEMPORARY — deleted at the end of Phase 1 (Step 6).
 *
 * Uses inline fixtures rather than the content provider on purpose: a
 * styleguide should show components in controlled states, including the
 * awkward ones (no rating, absurdly long title, missing year). Wiring it to a
 * live provider would make it depend on whatever TMDB happens to be trending
 * and would burn API calls on every reload.
 */

export const metadata: Metadata = {
  title: "Styleguide",
};

const FIXTURES: TitleSummary[] = [
  {
    id: "1",
    mediaType: "movie",
    name: "The Godfather",
    year: 1972,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#3a2908", gradientTo: "#e8b33c" },
    rating: 9.2,
  },
  {
    id: "2",
    mediaType: "tv",
    name: "Breaking Bad",
    year: 2008,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#0b535d", gradientTo: "#35d6e8" },
    rating: 9.5,
  },
  {
    id: "3",
    mediaType: "tv",
    name: "Everything Everywhere All at Once: The Extended Multiversal Cut",
    year: 2022,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#2a0836", gradientTo: "#e83cc9" },
    rating: 7.8,
  },
  {
    id: "4",
    mediaType: "movie",
    name: "Untitled Project",
    year: null,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#08211a", gradientTo: "#2ee6a8" },
    rating: null,
  },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-line-subtle border-t py-10">
      <h2 className="font-display text-display-lg text-fg uppercase">{title}</h2>
      {note && <p className="text-body-sm text-fg-subtle mt-1 max-w-prose">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <p className="text-meta-sm text-fg-subtle mb-2 uppercase">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function StyleguidePage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <header className="pb-8">
        <p className="text-meta text-accent-2 uppercase">Phase 1 · Step 4</p>
        <h1 className="font-display text-display-2xl text-accent mt-2 uppercase">
          Styleguide
        </h1>
        <p className="text-fg-muted text-body mt-3 max-w-prose">
          Every component in every state. Tab through this page — each
          interactive element must show a cyan focus ring, distinct from the
          gold used for selected/active state.
        </p>
      </header>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Button"
        note="Labels use the display face (caps-only by nature). Renders a real <button>, or a Next <Link> when given href."
      >
        <Row label="Variants">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </Row>
        <Row label="Sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
        <Row label="With icons">
          <Button variant="primary">
            <PlusIcon className="size-4" />
            Watchlist
          </Button>
          <Button variant="secondary">
            <CheckIcon className="size-4" />
            Watched
          </Button>
          <Button variant="outline">
            <BookmarkIcon className="size-4" />
            Save
          </Button>
        </Row>
        <Row label="Loading / disabled">
          <Button isLoading>Loading</Button>
          <Button variant="secondary" isLoading>
            Loading
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
        </Row>
        <Row label="As link (renders <a>, focusable)">
          <Button href="/styleguide" variant="primary">
            Link button
          </Button>
          <Button href="/styleguide" variant="outline">
            Link outline
          </Button>
          <Button href="/styleguide" disabled>
            Disabled link
          </Button>
        </Row>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Badge" note="Tinted fills, not solid — solid gold is reserved for primary actions and active nav.">
        <Row label="Variants">
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="danger">Danger</Badge>
          <Badge variant="outline">Outline</Badge>
        </Row>
        <Row label="Sizes">
          <Badge size="sm">Small</Badge>
          <Badge size="md">Medium</Badge>
        </Row>
        <Row label="With icons — realistic usage">
          <Badge variant="secondary" icon={<FilmIcon className="size-3" />}>
            Film
          </Badge>
          <Badge variant="secondary" icon={<TvIcon className="size-3" />}>
            Series
          </Badge>
          <Badge variant="accent" icon={<StarIcon className="size-3" />}>
            9.2
          </Badge>
          <Badge variant="success">Returning</Badge>
          <Badge variant="neutral">Ended</Badge>
        </Row>
        <Row label="Genre chips">
          <Badge>Crime</Badge>
          <Badge>Drama</Badge>
          <Badge>Science Fiction</Badge>
          <Badge>Action &amp; Adventure</Badge>
        </Row>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Card">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Default card</CardTitle>
              <Badge variant="accent">New</Badge>
            </CardHeader>
            <CardBody>
              Body copy stays on the sans face because it is mixed-case. Bebas
              would render this as unreadable caps.
            </CardBody>
          </Card>

          <Card interactive>
            <CardHeader>
              <CardTitle>Interactive</CardTitle>
            </CardHeader>
            <CardBody>Border brightens on hover.</CardBody>
            <CardFooter>
              <Button size="sm" variant="secondary">
                Action
              </Button>
            </CardFooter>
          </Card>

          <Card padding="lg">
            <CardTitle>Large padding</CardTitle>
            <CardBody className="mt-2">
              Padding scale: none / sm / md / lg.
            </CardBody>
          </Card>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Tabs"
        note="Arrow keys move and select, Home/End jump to the ends, and selection wraps. Only the active tab is in the tab order (roving tabindex)."
      >
        <Tabs defaultValue="all">
          <TabsList label="Filter by media type">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="movies">Films</TabsTrigger>
            <TabsTrigger value="tv">Series</TabsTrigger>
            <TabsTrigger value="soon" disabled>
              Disabled
            </TabsTrigger>
          </TabsList>
          <TabsPanel value="all">
            <p className="text-body text-fg-muted">
              All titles. This panel is focusable, so keyboard users land on the
              content right after choosing a tab.
            </p>
          </TabsPanel>
          <TabsPanel value="movies">
            <p className="text-body text-fg-muted">Films only.</p>
          </TabsPanel>
          <TabsPanel value="tv">
            <p className="text-body text-fg-muted">Series only.</p>
          </TabsPanel>
          <TabsPanel value="soon">
            <p className="text-body text-fg-muted">Unreachable while disabled.</p>
          </TabsPanel>
        </Tabs>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Skeleton"
        note="Animation is gated on motion-safe, so under reduced-motion it holds a steady tone instead of freezing mid-pulse."
      >
        <Row label="Primitives">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-4 w-56" />
        </Row>
        <div className="mb-6 max-w-md">
          <p className="text-meta-sm text-fg-subtle mb-2 uppercase">Text block</p>
          <SkeletonText lines={4} />
        </div>
        <div>
          <p className="text-meta-sm text-fg-subtle mb-2 uppercase">
            Ticket skeleton — matches TicketCard geometry exactly, so the grid
            does not reflow when data arrives
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <TicketCardSkeleton />
            <TicketCardSkeleton />
            <TicketCardSkeleton />
            <TicketCardSkeleton />
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="TicketCard"
        note="Notches and perforation are punched with mask-image — no image assets. The mask sits on an inner element so the focus ring is never clipped. Tab into the grid to confirm."
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {FIXTURES.map((title) => (
            <TicketCard key={title.id} title={title} href="/styleguide" />
          ))}
        </div>

        <p className="text-meta-sm text-fg-subtle mt-8 mb-2 uppercase">
          On a non-default background — proves the notches are cut, not painted
          with the page colour
        </p>
        <div className="rounded-lg bg-[oklch(0.55_0.17_25)] p-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {FIXTURES.slice(0, 4).map((title) => (
              <TicketCard key={title.id} title={title} href={null} />
            ))}
          </div>
        </div>

        <p className="text-meta-sm text-fg-subtle mt-8 mb-2 uppercase">
          Loading state alongside, for comparison
        </p>
        <SkeletonGrid count={5} />
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="EmptyState"
        note="The first thing a new user sees on Library and Search, and the fallback for every failed fetch."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card padding="none">
            <EmptyState
              icon={<BookmarkIcon />}
              title="Your library is empty"
              body="Titles you track will appear here. Start by finding something you have been meaning to watch."
              action={
                <Button href="/styleguide">
                  <SearchIcon className="size-4" />
                  Browse titles
                </Button>
              }
            />
          </Card>

          <Card padding="none">
            <EmptyState
              icon={<SearchIcon />}
              title="No results"
              body={
                <>
                  Nothing matched <span className="text-fg">“zzzzz”</span>. Try a
                  different spelling.
                </>
              }
            />
          </Card>

          <Card padding="none">
            <EmptyState
              icon={<AlertIcon />}
              tone="danger"
              title="Could not load titles"
              body="TMDB did not respond in time. This is usually temporary."
              action={
                <>
                  <Button variant="primary">Try again</Button>
                  <Button variant="ghost">Go home</Button>
                </>
              }
            />
          </Card>

          <Card padding="none">
            <EmptyState
              icon={<CompassIcon />}
              title="Nothing here yet"
              body="No icon-free variant needed — but the action is genuinely optional."
            />
          </Card>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Phase 4 re-theming"
        note="Both blocks below are IDENTICAL markup. The right one only overrides --accent-primary and --accent-secondary on its wrapper. Every component beneath re-tints with no component-level change — this is the mechanism Phase 4 will drive from artwork colours."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <ThemeDemo label="Default tokens" />
          <div
            style={
              {
                "--accent-primary": "#ff5c8a",
                "--accent-secondary": "#7c5cff",
              } as React.CSSProperties
            }
          >
            <ThemeDemo label="Scoped override" />
          </div>
        </div>
      </Section>
    </main>
  );
}

function ThemeDemo({ label }: { label: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-accent">{label}</CardTitle>
        <Badge variant="accent">Accent</Badge>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary">Primary</Button>
        <Button variant="outline">Outline</Button>
        <Badge variant="secondary">Secondary</Badge>
      </div>
      <div className="mt-4">
        <Tabs defaultValue="a">
          <TabsList label={`${label} example tabs`}>
            <TabsTrigger value="a">Active</TabsTrigger>
            <TabsTrigger value="b">Inactive</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </Card>
  );
}
