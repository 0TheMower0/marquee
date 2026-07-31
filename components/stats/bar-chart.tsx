import { cn } from "@/lib/utils/cn";

export interface BarChartDatum {
  label: string;
  value: number;
}

/**
 * A real bar chart, hand-rolled: no charting library. This project has none
 * today and a demonstrated preference for avoiding one — see the doc comment
 * on `Icon()` in components/ui/icons.tsx for the identical argument made
 * about icons. Bars are `bg-accent`/`bg-accent-2`, so they re-theme for free
 * and need no wrapper work a library's own color props would.
 *
 * Stacked layout (label+value on one line, a full-width bar below) rather
 * than side-by-side label/bar/value — a fixed label column either truncates
 * long genre/show names or forces the bar itself to shrink unpredictably at
 * 375px. Stacking guarantees the bar always has the full row width.
 */
export function BarChart({
  data,
  formatValue = (value: number) => String(value),
  accent = "accent",
  emptyMessage = "Nothing to show yet.",
}: {
  data: BarChartDatum[];
  formatValue?: (value: number) => string;
  accent?: "accent" | "accent-2";
  emptyMessage?: string;
}) {
  if (data.length === 0) {
    return <p className="text-body-sm text-fg-subtle">{emptyMessage}</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="space-y-3">
      {data.map((datum) => (
        <div key={datum.label}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-body-sm text-fg truncate">{datum.label}</span>
            <span className="text-meta-sm text-fg-subtle shrink-0 tabular-nums">
              {formatValue(datum.value)}
            </span>
          </div>
          <div className="bg-overlay mt-1 h-2 w-full overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full motion-safe:transition-[width] motion-safe:duration-[--dur-base]",
                accent === "accent" ? "bg-accent" : "bg-accent-2",
              )}
              style={{ width: `${(datum.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
