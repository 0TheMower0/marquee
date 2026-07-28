import type { ElementType, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type CardPadding = "none" | "sm" | "md" | "lg";

const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Defaults to a semantically neutral <div>; pass "article"/"section" where
   *  the content genuinely is one. */
  as?: ElementType;
  padding?: CardPadding;
  /** Adds hover affordance. Only set this when the whole card is actually
   *  clickable — the interactive element itself must still be a real
   *  <a>/<button> inside. */
  interactive?: boolean;
  children?: ReactNode;
}

export function Card({
  as: Component = "div",
  padding = "md",
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Component
      className={cn(
        "bg-surface border-line-subtle rounded-lg border",
        PADDING[padding],
        interactive &&
          "hover:border-line motion-safe:transition-colors motion-safe:duration-[--dur-base]",
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

export function CardHeader({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("font-display text-display-md text-fg uppercase", className)}
      {...rest}
    >
      {children}
    </h3>
  );
}

export function CardBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  // Body copy is mixed-case, so it stays on the sans face — never font-display.
  return (
    <div className={cn("text-body-sm text-fg-muted", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-line-subtle mt-4 flex items-center gap-2 border-t pt-3", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
