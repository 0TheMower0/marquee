import "server-only";

import type { PlaceholderArt } from "@/lib/content/types";

import { extractPalette } from "./extract";
import {
  harmonizeAccent,
  harmonizeDim,
  harmonizeHover,
  rotateHue,
  MARQUEE_CYAN,
  MARQUEE_CYAN_DIM,
  MARQUEE_CYAN_HOVER,
  MARQUEE_GOLD,
  MARQUEE_GOLD_DIM,
  MARQUEE_GOLD_HOVER,
  SECONDARY_HUE_ROTATION,
} from "./harmonize";
import { parseHex, rgbToOklch, type Oklch } from "./oklch";

export { MARQUEE_GOLD, MARQUEE_CYAN } from "./harmonize";

/**
 * Where a resolved accent actually came from. Surfaced on the theme object —
 * and as a `data-` attribute on the page — because "extracted from the poster"
 * and "derived from a hash-picked gradient" are genuinely different claims,
 * and conflating them would make the feature impossible to debug or to reason
 * about honestly.
 */
export type AccentOrigin =
  /** Sampled from the title's real poster or backdrop. */
  | "artwork"
  /** Sampled from the title's deterministic placeholder gradient. This is what
   *  mock mode always uses, and what tmdb mode uses for a title with no
   *  artwork. NOT extracted from any image. */
  | "gradient"
  /** Nothing usable was found; this is the brand palette. */
  | "fallback";

export type SecondaryOrigin =
  | AccentOrigin
  /** No honest second hue existed, so this is the primary's hue rotated. A
   *  design derivation, not an observation of the artwork. */
  | "derived";

export interface TitleTheme {
  primary: string;
  primaryHover: string;
  primaryDim: string;
  secondary: string;
  secondaryHover: string;
  secondaryDim: string;
  primaryOrigin: AccentOrigin;
  secondaryOrigin: SecondaryOrigin;
}

/** The subset of a Title this module needs. Narrower than `Title` on purpose —
 *  theming has no business reading a cast list, and a narrow input keeps this
 *  callable from a test with a three-field literal. */
export interface TitleThemeSource {
  posterUrl: string | null;
  backdropUrl?: string | null;
  placeholder: PlaceholderArt;
}

const BRAND_THEME: TitleTheme = {
  primary: MARQUEE_GOLD,
  primaryHover: MARQUEE_GOLD_HOVER,
  primaryDim: MARQUEE_GOLD_DIM,
  secondary: MARQUEE_CYAN,
  secondaryHover: MARQUEE_CYAN_HOVER,
  secondaryDim: MARQUEE_CYAN_DIM,
  primaryOrigin: "fallback",
  secondaryOrigin: "fallback",
};

/** Builds the full set of variants around one verified accent. */
function expand(primary: string, secondary: string) {
  return {
    primary,
    primaryHover: harmonizeHover(primary),
    primaryDim: harmonizeDim(primary),
    secondary,
    secondaryHover: harmonizeHover(secondary),
    secondaryDim: harmonizeDim(secondary),
  };
}

/**
 * Resolves the accent palette for one title.
 *
 * Order of preference:
 *   1. the real poster (designed artwork — deliberate palettes)
 *   2. the backdrop (a film still: often muddy, so only a fallback)
 *   3. the title's placeholder gradient (always available, deterministic)
 *   4. marquee gold
 *
 * Every candidate goes through the identical clamp-and-verify path in
 * ./harmonize, so a gradient-derived accent is held to exactly the same WCAG
 * AA bar as an artwork-derived one. Never throws.
 */
export async function resolveTitleTheme(source: TitleThemeSource): Promise<TitleTheme> {
  const artworkUrl = source.posterUrl ?? source.backdropUrl ?? null;

  let candidate: Oklch | null = null;
  let secondaryCandidate: Oklch | null = null;
  let origin: AccentOrigin = "fallback";

  if (artworkUrl) {
    const palette = await extractPalette(artworkUrl);
    if (palette) {
      candidate = palette.primary;
      secondaryCandidate = palette.secondary;
      origin = "artwork";
    }
  }

  if (!candidate) {
    // The bright stop. `gradientFrom` is a darker shade of the SAME hue in
    // every pair (see shared/placeholder.ts), so it would never yield a
    // distinct secondary — hence the rotation below rather than using it.
    const rgb = parseHex(source.placeholder.gradientTo);
    if (rgb) {
      candidate = rgbToOklch(rgb);
      secondaryCandidate = null;
      origin = "gradient";
    }
  }

  if (!candidate) return BRAND_THEME;

  const primary = harmonizeAccent(candidate);
  if (!primary) return BRAND_THEME;

  let secondary: string | null = null;
  let secondaryOrigin: SecondaryOrigin = origin;

  if (secondaryCandidate) {
    secondary = harmonizeAccent(secondaryCandidate);
  }
  if (!secondary) {
    secondary = harmonizeAccent(rotateHue(candidate, SECONDARY_HUE_ROTATION));
    secondaryOrigin = "derived";
  }
  if (!secondary) {
    secondary = MARQUEE_CYAN;
    secondaryOrigin = "fallback";
  }

  return {
    ...expand(primary, secondary),
    primaryOrigin: origin,
    secondaryOrigin,
  };
}

/**
 * The custom properties to set on the theming wrapper.
 *
 * These are exactly the semantic aliases declared in globals.css `:root`, and
 * they re-resolve at every element *because* `@theme` is declared `inline`
 * (see the header comment there). Overriding them here re-tints every
 * `bg-accent` / `text-accent` / `border-accent` beneath this element with no
 * component changes at all — which is the whole point of the token
 * architecture set up in Phase 1 Step 1.
 */
export function titleThemeVars(theme: TitleTheme): Record<string, string> {
  return {
    "--accent-primary": theme.primary,
    "--accent-primary-hover": theme.primaryHover,
    "--accent-primary-dim": theme.primaryDim,
    "--accent-secondary": theme.secondary,
    "--accent-secondary-hover": theme.secondaryHover,
    "--accent-secondary-dim": theme.secondaryDim,
  };
}
