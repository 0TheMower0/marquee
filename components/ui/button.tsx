import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";
import { SpinnerIcon } from "./icons";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * Button labels use the display face. Bebas is caps-only, which is exactly
 * right for short action labels and reinforces the marquee identity — but it
 * means a label must never carry mixed-case meaning (a title, a username).
 */
const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-display uppercase " +
  "border transition-colors duration-[--dur-fast] " +
  // Disabled styling is handled here rather than per-variant so no variant can
  // ship without it. `pointer-events-none` also covers the anchor form, where
  // there is no native disabled attribute.
  "disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent border-transparent hover:bg-accent-hover active:brightness-95",
  secondary:
    "bg-surface text-fg border-line hover:bg-overlay hover:border-line-strong",
  // `/12` alpha on a semantic token still re-themes — the alpha modifier is
  // applied to whatever colour the token currently resolves to.
  outline:
    "bg-transparent text-accent border-accent hover:bg-accent/12",
  ghost:
    "bg-transparent text-fg-muted border-transparent hover:bg-overlay hover:text-fg",
  danger:
    "bg-danger text-on-accent border-transparent hover:brightness-110 active:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-display-sm",
  md: "h-10 px-4 text-display-sm",
  lg: "h-12 px-6 text-display-md",
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  className?: string;
  children?: ReactNode;
}

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    href?: undefined;
  };

type ButtonAsLink = CommonProps & {
  href: string;
  /** Anchors have no disabled state; this maps to aria-disabled + no href. */
  disabled?: boolean;
};

export type ButtonProps = ButtonAsButton | ButtonAsLink;

/**
 * Renders a real <button> by default, or a Next <Link> when `href` is given.
 * Never a <div> with a click handler — keyboard activation, focus order, and
 * the global :focus-visible ring all depend on the correct element.
 */
export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    isLoading = false,
    className,
    children,
  } = props;

  const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);

  const content = (
    <>
      {isLoading && (
        <SpinnerIcon className="size-4 motion-safe:animate-spin" />
      )}
      {children}
    </>
  );

  if ("href" in props && props.href !== undefined) {
    const { href, disabled } = props;
    if (disabled) {
      // A disabled link must not be reachable by keyboard or activatable, so
      // it loses its href and becomes a plain span with the right semantics.
      return (
        <span role="link" aria-disabled="true" className={classes}>
          {content}
        </span>
      );
    }
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  // Strip the styling props so they don't land on the DOM node as invalid
  // attributes; everything else (onClick, form, aria-*, ...) passes through.
  const {
    variant: _variant,
    size: _size,
    isLoading: _isLoading,
    className: _className,
    children: _children,
    disabled,
    ...rest
  } = props as ButtonAsButton;
  void _variant;
  void _size;
  void _isLoading;
  void _className;
  void _children;

  return (
    <button
      // Explicit: an unspecified type inside a <form> defaults to "submit",
      // which silently submits the form.
      type="button"
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={classes}
      {...rest}
    >
      {content}
    </button>
  );
}
