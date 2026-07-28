import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type BadgeVariant =
  | "neutral"
  | "accent"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "outline";
export type BadgeSize = "sm" | "md";

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "bg-overlay text-fg-muted border-line-subtle",
  // Tinted fills rather than solid ones: a grid of solid gold chips would
  // out-shout the poster art they sit beside. Solid gold is reserved for
  // primary actions and active nav.
  accent: "bg-accent/15 text-accent border-accent/30",
  secondary: "bg-accent-2/15 text-accent-2 border-accent-2/30",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  danger: "bg-danger/15 text-danger border-danger/30",
  outline: "bg-transparent text-fg-muted border-line",
};

const SIZES: Record<BadgeSize, string> = {
  sm: "h-5 px-1.5 text-meta-sm",
  md: "h-6 px-2 text-meta",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * Metadata chip: genres, media type, status, ratings.
 *
 * Uppercased via CSS rather than by transforming the string, so the accessible
 * name announced by a screen reader stays "Science Fiction" rather than being
 * read letter-by-letter as an acronym.
 */
export function Badge({
  variant = "neutral",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-xs border uppercase",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}
