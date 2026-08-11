"use client";

import { useHomeConfig } from "@/components/home/use-home-config";
import { ChevronDownIcon } from "@/components/ui/icons";
import type { FirstPage, HomeSectionId } from "@/lib/home";

const FIRST_PAGE_OPTIONS: { value: FirstPage; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "library", label: "Library" },
  { value: "schedule", label: "Schedule" },
  { value: "search", label: "Search" },
];

const SECTION_LABELS: Record<HomeSectionId, string> = {
  upNext: "Up Next",
  trending: "Trending",
};

/**
 * Everything below is a `lib/home` preference — local-first, synced like the
 * rest of this app's state, never gated on an account. Moviebase paywalls
 * exactly this; here it's Settings.
 */
export function SettingsView() {
  const {
    ready,
    config,
    writeFailed,
    setFirstPage,
    moveSectionDirection,
    toggleSectionVisible,
    setShowStreakBadge,
  } = useHomeConfig();

  return (
    <div className="space-y-10 pb-8">
      <header>
        <h1 className="font-display text-display-lg text-fg uppercase">Settings</h1>
        <p className="text-body-sm text-fg-subtle mt-1 max-w-prose">
          Arrange Home however you like — what shows up, in what order, and
          where the app opens.
        </p>
      </header>

      <section aria-labelledby="first-page-heading" className="space-y-3">
        <h2
          id="first-page-heading"
          className="font-display text-display-md text-fg uppercase"
        >
          Open to
        </h2>
        <p className="text-meta text-fg-muted max-w-prose">
          Where the app lands on a fresh open — not while you&rsquo;re already
          navigating around inside it.
        </p>
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2" disabled={!ready}>
          <legend className="sr-only">First page</legend>
          {FIRST_PAGE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="text-body-sm text-fg flex items-center gap-2.5"
            >
              <input
                type="radio"
                name="first-page"
                checked={config.firstPage === option.value}
                onChange={() => setFirstPage(option.value)}
                className="accent-accent size-4"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </section>

      <section aria-labelledby="sections-heading" className="space-y-3">
        <h2
          id="sections-heading"
          className="font-display text-display-md text-fg uppercase"
        >
          Home sections
        </h2>
        <p className="text-meta text-fg-muted max-w-prose">
          Choose what appears on Home, and in what order.
        </p>

        <ul className="divide-line-subtle border-line-subtle divide-y rounded-md border">
          {config.sections.map((section, index) => (
            <li
              key={section.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <label className="text-body-sm text-fg flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={section.visible}
                  disabled={!ready}
                  onChange={() => toggleSectionVisible(section.id)}
                  className="accent-accent size-4"
                />
                {SECTION_LABELS[section.id]}
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move ${SECTION_LABELS[section.id]} up`}
                  disabled={!ready || index === 0}
                  onClick={() => moveSectionDirection(section.id, "up")}
                  className="text-fg-muted hover:bg-overlay hover:text-fg rounded-sm p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDownIcon className="size-4 rotate-180" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${SECTION_LABELS[section.id]} down`}
                  disabled={!ready || index === config.sections.length - 1}
                  onClick={() => moveSectionDirection(section.id, "down")}
                  className="text-fg-muted hover:bg-overlay hover:text-fg rounded-sm p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDownIcon className="size-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="streak-heading" className="space-y-3">
        <h2
          id="streak-heading"
          className="font-display text-display-md text-fg uppercase"
        >
          Streak badge
        </h2>
        <label className="text-body-sm text-fg flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={config.showStreakBadge}
            disabled={!ready}
            onChange={(event) => setShowStreakBadge(event.target.checked)}
            className="accent-accent size-4"
          />
          Show my streak on Home
        </label>
      </section>

      {/* Same shape as NotificationSettings' own aria-live status line — the
          only visible feedback a preference save gets is on FAILURE. Success
          is silent: the control itself already shows the new state. */}
      {writeFailed && (
        <p role="alert" className="text-danger text-body-sm">
          That change didn&rsquo;t save — your last setting has been restored.
          Try again.
        </p>
      )}
    </div>
  );
}
