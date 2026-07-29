import { TicketCard } from "@/components/title/ticket-card";
import type { TitleSummary } from "@/lib/content/types";
import { cn } from "@/lib/utils/cn";
import { TITLE_GRID_CLASS } from "@/lib/utils/grid";

interface TitleGridProps {
  titles: TitleSummary[];
  /**
   * How many leading cards load their artwork eagerly. Everything past the
   * first visible row should stay lazy, or a 20-card grid fires 20 poster
   * requests that compete with the ones actually on screen.
   */
  priorityCount?: number;
  /** Announced to screen readers via aria-label, e.g. "Trending titles". */
  label: string;
  className?: string;
}

/**
 * A <ul> rather than a bare <div>: a screen reader then announces "list, 20
 * items" and offers item-by-item navigation, which is exactly the affordance
 * a grid of cards should have. TicketCard renders its own <article>, so each
 * <li> stays presentational.
 */
export function TitleGrid({
  titles,
  priorityCount = 0,
  label,
  className,
}: TitleGridProps) {
  return (
    <ul aria-label={label} className={cn(TITLE_GRID_CLASS, className)}>
      {titles.map((title, index) => (
        <li key={`${title.mediaType}:${title.id}`}>
          <TicketCard title={title} priority={index < priorityCount} />
        </li>
      ))}
    </ul>
  );
}
