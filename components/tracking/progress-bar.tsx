import { cn } from "@/lib/utils/cn";

/** Shared by show-level and season-level progress — same visual, same math. */
export function ProgressBar({
  percent,
  className,
}: {
  percent: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "bg-overlay h-1.5 w-full overflow-hidden rounded-full",
        className,
      )}
    >
      <div
        className="bg-accent motion-safe:transition-[width] motion-safe:duration-[--dur-base] h-full rounded-full"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
