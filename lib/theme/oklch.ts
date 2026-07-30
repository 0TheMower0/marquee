/**
 * Colour-space maths for per-title theming. Pure — no I/O, no React, no
 * environment access — so every value below is unit-testable against hand-
 * computed numbers (see oklch.test.ts).
 *
 * OKLCH rather than HSL, and the reason is load-bearing rather than
 * fashionable: OKLCH's L is *perceptual* lightness, so one lightness clamp
 * behaves consistently across every hue. In HSL, `hsl(60 100% 50%)` (yellow)
 * and `hsl(240 100% 50%)` (blue) claim the same 50% lightness while differing
 * by roughly an order of magnitude in actual luminance. Clamping HSL lightness
 * into a "safe band" would therefore produce colours that are readable at some
 * hues and illegible at others — exactly the failure this module exists to
 * prevent.
 *
 * Conversion constants are Björn Ottosson's OKLab matrices.
 */

export interface Oklch {
  /** Perceptual lightness, 0–1. */
  L: number;
  /** Chroma. Roughly 0–0.37 within sRGB; 0 is a pure grey. */
  C: number;
  /** Hue angle in degrees, normalized to [0, 360). */
  h: number;
}

/** 8-bit sRGB channels, 0–255. */
export type Rgb = readonly [number, number, number];

/* ---------------------------------------------------------------------------
 * sRGB transfer function
 * ------------------------------------------------------------------------ */

/** sRGB channel (0–1) to linear-light. */
export function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Linear-light channel to sRGB (0–1). */
export function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/* ---------------------------------------------------------------------------
 * sRGB <-> OKLCH
 * ------------------------------------------------------------------------ */

export function rgbToOklch([r, g, b]: Rgb): Oklch {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    L,
    C: Math.hypot(a, bb),
    h: (((Math.atan2(bb, a) * 180) / Math.PI) + 360) % 360,
  };
}

/** OKLCH to *unclamped* linear-light RGB. Values outside [0,1] mean the colour
 *  falls outside the sRGB gamut — which is what `oklchInGamut` tests for. */
function oklchToLinearRgb({ L, C, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * Whether an OKLCH triple is representable in sRGB. A small epsilon absorbs
 * float error at the gamut boundary, so a colour that is mathematically
 * exactly on the edge isn't rejected by a 1e-16 overshoot.
 */
export function oklchInGamut(colour: Oklch): boolean {
  return oklchToLinearRgb(colour).every((c) => c >= -0.001 && c <= 1.001);
}

/** OKLCH to 8-bit sRGB, clamped into gamut. Use `oklchInGamut` first if you
 *  need to know whether clamping actually distorted the colour. */
export function oklchToRgb(colour: Oklch): Rgb {
  return oklchToLinearRgb(colour).map((c) =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255),
  ) as unknown as Rgb;
}

/* ---------------------------------------------------------------------------
 * Hex
 * ------------------------------------------------------------------------ */

/** Parses `#rgb` / `#rrggbb`. Returns null rather than throwing — callers here
 *  handle bad input by falling back to a brand colour, never by crashing. */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/* ---------------------------------------------------------------------------
 * WCAG contrast
 * ------------------------------------------------------------------------ */

/** WCAG 2.1 relative luminance. Note these coefficients are NOT OKLab's — this
 *  is deliberately the accessibility definition, not the perceptual one, because
 *  it is what the success criterion is written against. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return (
    0.2126 * srgbToLinear(r / 255) +
    0.7152 * srgbToLinear(g / 255) +
    0.0722 * srgbToLinear(b / 255)
  );
}

/** WCAG 2.1 contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
