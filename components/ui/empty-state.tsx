import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type EmptyStateTone = "neutral" | "danger";

const TONES: Record<EmptyStateTone, { ring: string; icon: string }> = {
  neutral: { ring: "border-accent/25 bg-accent/8", icon: "text-accent" },
  danger: { ring: "border-danger/30 bg-danger/10", icon: "text-danger" },
};

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  /** Mixed-case prose, so it renders on the sans face, never Bebas. */
  body?: ReactNode;
  /** Typically a <Button>. Optional — plenty of empty states have no action. */
  action?: ReactNode;
  tone?: EmptyStateTone;
  className?: string;
}

/**
 * The first thing a new user sees on Library, Search, and any failed fetch, so
 * it carries more of the app's first impression than its size suggests.
 *
 * Deliberate choices:
 * - The icon sits in a ringed medallion rather than floating loose, which
 *   gives an otherwise very empty screen a visual anchor.
 * - The icon is decorative (aria-hidden via the Icon component) because the
 *   title already states the situation; announcing it twice is noise.
 * - Centred with a max-width on the prose: a single line of body text spanning
 *   a 1200px desktop viewport is unreadable.
 * - The real heading is an <h2>, so it appears in the document outline and
 *   screen-reader heading navigation instead of being styled-up text.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  tone = "neutral",
  className,
}: EmptyStateProps) {
  const toneClasses = TONES[tone];

  return (
    <section
      className={cn(
        "flex flex-col items-center justify-center px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "mb-5 flex size-16 items-center justify-center rounded-full border",
            toneClasses.ring,
            toneClasses.icon,
          )}
        >
          <span className="[&>svg]:size-7">{icon}</span>
        </div>
      )}

      <h2 className="font-display text-display-lg text-fg uppercase">{title}</h2>

      {body && (
        <p className="text-body text-fg-muted mt-2 max-w-prose text-balance">
          {body}
        </p>
      )}

      {action && <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div>}
    </section>
  );
}
