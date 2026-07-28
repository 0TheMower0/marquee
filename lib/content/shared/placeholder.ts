import type { PlaceholderArt } from "../types";

/**
 * A small curated set of two-stop gradients pulled from the marquee palette
 * plus a few adjacent hues, so a hashed "random" pick still looks deliberate
 * rather than arbitrary. Used by mockProvider for every title, and reused by
 * tmdbProvider (Step 3) as a fallback whenever TMDB has no poster/backdrop
 * image — the "no external images ever required" guarantee has to hold for
 * both providers, not just mock.
 */
const GRADIENTS: PlaceholderArt[] = [
  { gradientFrom: "#3a2908", gradientTo: "#e8b33c" }, // gold
  { gradientFrom: "#0b535d", gradientTo: "#35d6e8" }, // cyan
  { gradientFrom: "#3a0d1f", gradientTo: "#e83c6b" }, // marquee red
  { gradientFrom: "#1a0d3a", gradientTo: "#7c5cff" }, // violet
  { gradientFrom: "#08211a", gradientTo: "#2ee6a8" }, // emerald
  { gradientFrom: "#3a1c08", gradientTo: "#ff8a3c" }, // ember
  { gradientFrom: "#0d1c3a", gradientTo: "#3c8cff" }, // cobalt
  { gradientFrom: "#2a0836", gradientTo: "#e83cc9" }, // magenta
];

/** FNV-1a — fast, deterministic, no dependency. Same id always maps to the
 *  same gradient, so a title's art never flickers between re-renders. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function derivePlaceholderArt(id: string): PlaceholderArt {
  return GRADIENTS[hash(id) % GRADIENTS.length];
}
