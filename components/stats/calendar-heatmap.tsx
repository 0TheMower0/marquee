import { cn } from "@/lib/utils/cn";

export interface HeatmapDatum {
  day: string;
  count: number;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function intensityClass(count: number, max: number): string {
  if (count === 0) return "bg-overlay";
  const ratio = count / max;
  if (ratio > 0.75) return "bg-accent";
  if (ratio > 0.5) return "bg-accent/70";
  if (ratio > 0.25) return "bg-accent/45";
  return "bg-accent/25";
}

/**
 * A GitHub-style contribution grid over one calendar year of watch-log
 * activity — weeks as columns, Sun-Sat as rows. `days` must already be a
 * complete, zero-filled year (see `computeHeatmap` in lib/stats), so this
 * component does no calendar math itself beyond padding the first week to
 * start on a Sunday.
 *
 * Deliberately scrolls horizontally inside its OWN container
 * (`overflow-x-auto`) rather than shrinking cells to fit 375px — 53 weeks at
 * a legible cell size cannot fit a phone width, and GitHub's own mobile view
 * makes the identical trade. The page itself never gains horizontal scroll,
 * only this one element.
 */
export function CalendarHeatmap({ days }: { days: HeatmapDatum[] }) {
  if (days.length === 0) return null;

  const max = Math.max(...days.map((d) => d.count), 1);

  // `T00:00:00` forces local-time parsing — a bare "YYYY-MM-DD" string
  // parses as UTC midnight, which can read back as the previous day west of
  // Greenwich (the same hazard documented in lib/watchlog/types.ts).
  const firstDate = new Date(`${days[0].day}T00:00:00`);
  const leadingBlanks = firstDate.getDay();
  const cells: (HeatmapDatum | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...days,
  ];

  const weeks: (HeatmapDatum | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  let lastMonth = -1;
  const monthLabels = weeks.map((week) => {
    const firstDay = week.find((d): d is HeatmapDatum => d !== null);
    if (!firstDay) return "";
    const month = Number(firstDay.day.slice(5, 7)) - 1;
    if (month === lastMonth) return "";
    lastMonth = month;
    return MONTH_LABELS[month];
  });

  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-flex flex-col gap-1">
        <div className="flex gap-[3px]">
          {monthLabels.map((label, i) => (
            <span
              key={i}
              className="text-meta-sm text-fg-subtle w-[11px] shrink-0 overflow-visible whitespace-nowrap"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="flex gap-[3px]">
          {weeks.map((week, weekIndex) => (
            <div key={weekIndex} className="flex flex-col gap-[3px]">
              {week.map((day, dayIndex) => (
                <div
                  key={dayIndex}
                  title={day ? `${day.day}: ${day.count} watched` : undefined}
                  className={cn(
                    "size-[11px] rounded-[2px]",
                    day ? intensityClass(day.count, max) : "opacity-0",
                  )}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="text-meta-sm text-fg-subtle flex items-center gap-1 pt-1">
          <span>Less</span>
          <span className="bg-overlay size-[11px] rounded-[2px]" />
          <span className="bg-accent/25 size-[11px] rounded-[2px]" />
          <span className="bg-accent/45 size-[11px] rounded-[2px]" />
          <span className="bg-accent/70 size-[11px] rounded-[2px]" />
          <span className="bg-accent size-[11px] rounded-[2px]" />
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
