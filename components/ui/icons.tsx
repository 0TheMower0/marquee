import type { SVGProps } from "react";

/**
 * Hand-rolled inline icons rather than an icon package.
 *
 * Reasons: no runtime dependency to keep in sync, no tree-shaking guesswork,
 * and — most importantly — `stroke="currentColor"` means every icon inherits
 * the semantic text token of whatever contains it. An icon inside a re-themed
 * Phase 4 wrapper re-tints for free.
 *
 * Icons are decorative by default (`aria-hidden`), because in every current
 * usage the adjacent text already carries the meaning. Pass `aria-hidden={false}`
 * plus a title if one ever needs to stand alone.
 */

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function FilmIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </Icon>
  );
}

export function TvIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="7" width="20" height="13" rx="2" />
      <path d="m8 3 4 4 4-4" />
    </Icon>
  );
}

export function BookmarkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3.5 2.6 5.5 5.9.8-4.3 4.2 1 6-5.2-2.9L6.8 20l1-6-4.3-4.2 5.9-.8Z" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17.2v.1" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Icon>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9h12v-9" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-4 4-6 7.5-6s6.1 2 7.5 6" />
    </Icon>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5Z" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

/** "Mark watched up to here" — the binge-catchup action on an episode row. */
export function SkipToIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 6 5 6-5" />
      <path d="m6 13 6 5 6-5" />
    </Icon>
  );
}

/** The badges indicator — distinct from StarIcon, which is XP's. */
export function RibbonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="5" />
      <path d="m9 12.5-2 8 5-3 5 3-2-8" />
    </Icon>
  );
}

/** The streak indicator. */
export function FlameIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5c.6 3-2.7 4.4-2.7 7.7a2.7 2.7 0 0 0 5.4 0c1.2 1 1.8 2.4 1.8 3.8a4.5 4.5 0 0 1-9 0c0-4.5 4-5.4 4.5-11.5Z" />
    </Icon>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      {/* Track plus a single arc — the arc alone reads as a spinner only while
          rotating, and rotation is suppressed under reduced motion. */}
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </Icon>
  );
}

/**
 * The one icon that does NOT go through `Icon()`.
 *
 * Every other mark here is a stroked outline on a 24px grid, which is what
 * `Icon` sets up. The GitHub logo is a solid glyph on a 16px grid, and
 * redrawing it as an outline would make it stop being the mark GitHub's brand
 * guidelines require for a "Continue with GitHub" button. `fill="currentColor"`
 * keeps the one property that actually matters here: it still inherits the
 * semantic text token of whatever contains it, so it re-themes like the rest.
 */
export function GitHubIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
