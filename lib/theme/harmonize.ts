/**
 * Turns a raw candidate colour — pulled from artwork, or from a title's
 * placeholder gradient — into an accent that is guaranteed usable against
 * Marquee's near-black surfaces.
 *
 * Pure. No I/O. Every threshold here is a named constant so the tuning is
 * reviewable and the maths is testable (see harmonize.test.ts).
 *
 * The contract, in one line: **this module never returns a colour that has not
 * been measured against WCAG AA.** Clamping into a "safe-looking" band is not
 * sufficient on its own and is not treated as sufficient — see VERIFY below.
 */

import {
  contrastRatio,
  oklchInGamut,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  toHex,
  type Oklch,
  type Rgb,
} from "./oklch";

/* ---------------------------------------------------------------------------
 * Brand reference points
 * ------------------------------------------------------------------------ */

/** Must stay in sync with globals.css. These are the fallbacks, so if they
 *  drift the fallback stops matching the rest of the app. */
export const MARQUEE_GOLD = "#e8b33c"; // --gold-400
export const MARQUEE_GOLD_HOVER = "#efcc6d"; // --gold-300
export const MARQUEE_GOLD_DIM = "#6b4c10"; // --gold-700
export const MARQUEE_CYAN = "#35d6e8"; // --cyan-400
export const MARQUEE_CYAN_HOVER = "#66e1ee"; // --cyan-300
export const MARQUEE_CYAN_DIM = "#0b535d"; // --cyan-700

/** The two surfaces an accent is measured against. Both are near-black — see
 *  the note on VERIFY below, which depends on that being true. */
const SURFACE_BG = parseHex("#0b0b0e") as Rgb; // --ink-800, --bg-base
const SURFACE_ON_ACCENT = parseHex("#060608") as Rgb; // --ink-900, --fg-on-accent

/* ---------------------------------------------------------------------------
 * The usable band
 * ------------------------------------------------------------------------ */

/**
 * Derived from where the brand accents already sit, so extracted colours land
 * in the same visual register as the designed ones rather than looking like a
 * different app:
 *
 *   gold #e8b33c -> oklch(0.795 0.143 83.5)
 *   cyan #35d6e8 -> oklch(0.804 0.127 206.5)
 *
 * Both sit comfortably inside the band below. That is the intent, not a
 * coincidence — the band was fitted to them.
 */
export const ACCENT_L_MIN = 0.74;
export const ACCENT_L_MAX = 0.86;
export const ACCENT_C_MIN = 0.07;
export const ACCENT_C_MAX = 0.19;

/** WCAG 2.1 AA for normal-size text. Deliberately the normal-text bar, not the
 *  large-text 3.0 — `text-accent` is used at metadata sizes. */
export const WCAG_AA_NORMAL = 4.5;

/**
 * VERIFY escape hatch. If a hue cannot satisfy AA anywhere up to this
 * lightness it is rejected outright rather than pushed further — past roughly
 * 0.92 a colour reads as off-white and has stopped being an accent, so
 * "succeeding" here would be worse than falling back to gold.
 */
const VERIFY_L_CEILING = 0.92;
const VERIFY_L_STEP = 0.01;

/** Chroma step used when walking a colour back into the sRGB gamut. */
const GAMUT_C_STEP = 0.005;

/** Hover is one small perceptual step lighter, matching how --gold-300 relates
 *  to --gold-400 (0.795 -> 0.855 in OKLCH L). */
const HOVER_L_DELTA = 0.06;

/**
 * Dim is a decorative low-contrast fill (borders, inert backgrounds), so it is
 * NOT contrast-verified — forcing it to 4.5:1 would make it not dim. It is
 * only pinned to a fixed low lightness in the accent's own hue so it stays
 * tonally related. Never put text on it.
 */
const DIM_L = 0.42;
const DIM_C_SCALE = 0.75;

/** Rotation used to invent a secondary when the artwork offers no honest second
 *  hue. 150 degrees is a split-complement: reliably distinct from the primary
 *  without the vibrating clash of an exact 180 complement. */
export const SECONDARY_HUE_ROTATION = 150;

/* ---------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Walks chroma down until the colour is representable in sRGB. Reducing
 *  chroma (rather than lightness) preserves the hue *and* the perceived
 *  brightness the contrast check depends on. */
function fitToGamut(colour: Oklch): Oklch {
  let { C } = colour;
  while (C > 0 && !oklchInGamut({ ...colour, C })) {
    C = Math.max(0, C - GAMUT_C_STEP);
  }
  return { ...colour, C };
}

function meetsContrast(rgb: Rgb): boolean {
  return (
    contrastRatio(rgb, SURFACE_BG) >= WCAG_AA_NORMAL &&
    contrastRatio(rgb, SURFACE_ON_ACCENT) >= WCAG_AA_NORMAL
  );
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

/**
 * Clamp a candidate into the usable band, then VERIFY it actually meets AA.
 *
 * Clamping alone is deliberately NOT trusted. WCAG relative luminance is not
 * perceptually uniform, so two colours at identical OKLCH lightness can differ
 * substantially in measured contrast depending on hue — a saturated blue at
 * L=0.74 is far darker by WCAG's reckoning than a yellow at L=0.74. The band
 * gets us close; only the measurement below is authoritative.
 *
 * Hue is never modified. Hue is the title's identity — it is the entire reason
 * a Chernobyl page reads cold and a Spider-Verse page reads electric. Only
 * lightness and chroma are negotiable.
 *
 * Returns null when no lightness in range satisfies AA, which the caller is
 * expected to treat as "fall back to brand gold".
 *
 * NOTE: the loop only ever walks lightness UP, which is correct *because both
 * reference surfaces are near-black* — raising lightness improves both ratios
 * simultaneously. If a light surface is ever introduced the two constraints
 * would start pulling in opposite directions and this becomes a search, not a
 * walk. Revisit here if that day comes.
 */
export function harmonizeAccent(candidate: Oklch): string | null {
  const chroma = clamp(candidate.C, ACCENT_C_MIN, ACCENT_C_MAX);
  const startL = clamp(candidate.L, ACCENT_L_MIN, ACCENT_L_MAX);

  for (let L = startL; L <= VERIFY_L_CEILING; L += VERIFY_L_STEP) {
    const rgb = oklchToRgb(fitToGamut({ L, C: chroma, h: candidate.h }));
    if (meetsContrast(rgb)) return toHex(rgb);
  }
  return null;
}

/** Lighter companion for `:hover`. Contrast-verified like the base accent,
 *  since it is used for both fills and text. Falls back to the base accent
 *  itself rather than to gold — a hover that matches the resting state is
 *  invisible, which beats a hover that clashes with the page. */
export function harmonizeHover(accentHex: string): string {
  const rgb = parseHex(accentHex);
  if (!rgb) return accentHex;
  const base = rgbToOklch(rgb);
  return harmonizeAccent({ ...base, L: base.L + HOVER_L_DELTA }) ?? accentHex;
}

/** Darker companion for decorative fills. Intentionally not contrast-verified
 *  — see DIM_L above. */
export function harmonizeDim(accentHex: string): string {
  const rgb = parseHex(accentHex);
  if (!rgb) return accentHex;
  const base = rgbToOklch(rgb);
  return toHex(oklchToRgb(fitToGamut({ L: DIM_L, C: base.C * DIM_C_SCALE, h: base.h })));
}

/** Rotates a hue by `degrees`, normalized to [0, 360). */
export function rotateHue(colour: Oklch, degrees: number): Oklch {
  return { ...colour, h: ((colour.h + degrees) % 360 + 360) % 360 };
}

/** Smallest angular distance between two hues, 0–180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}
