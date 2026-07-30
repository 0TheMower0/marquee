import "server-only";

import sharp from "sharp";

import { rgbToOklch, type Oklch } from "./oklch";

/**
 * Pulls candidate accent hues out of a title's artwork.
 *
 * Runs SERVER-SIDE, at request time, and the choice is deliberate. The
 * alternative — reading pixels off the loaded <img> with a canvas in the
 * browser — costs nothing on the server but guarantees the page paints in
 * default gold and then lurches to the real palette a beat later, on every
 * single navigation. For a feature whose entire purpose is "this page feels
 * like this title from the moment you arrive", that flash is not a cosmetic
 * nitpick, it is the feature failing. Client-side extraction is also gated on
 * the image having loaded, so the flash lasts longest on exactly the slow
 * connections where it is most jarring.
 *
 * The cost that buys is small and, more importantly, paid once rather than per
 * request: measured at 3-9ms of decode for a 32x48 sample, with the image
 * bytes themselves held in Next's persistent fetch data cache and the derived
 * palette held in the process-local LRU below.
 */

/* ---------------------------------------------------------------------------
 * Tuning
 * ------------------------------------------------------------------------ */

/** Sample size. ~1,500 pixels is plenty to find dominant hues and keeps decode
 *  in single-digit milliseconds; posters are 2:3 so the sample matches. */
const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 48;

const HUE_BINS = 24; // 15 degrees per bin

/** Pixels excluded from the histogram entirely. Letterbox bars, black borders
 *  and blown highlights are properties of the *crop*, not of the artwork. */
const MIN_PIXEL_L = 0.12;
const MAX_PIXEL_L = 0.95;

/** Below this chroma a pixel is grey and carries no hue information. Counting
 *  it would let a large neutral background outvote the actual colour. */
const MIN_PIXEL_C = 0.02;

/**
 * Fraction of usable pixels that must carry *any* hue before we trust the
 * result. A genuinely achromatic poster (a true black-and-white photograph)
 * lands around 1%, and for those the honest answer is that there is no colour
 * to extract — the caller falls back to gold rather than inventing a hue.
 */
const MIN_CHROMATIC_SHARE = 0.05;

/**
 * Within a hue bin, take a high-chroma representative rather than the mean.
 * This mattered a lot in testing: averaging washed The Batman's fire-orange
 * down to a muted brown, because the bin also contains every desaturated
 * shadow of that same hue. The 85th percentile keeps the colour the poster
 * actually reads as.
 */
const CHROMA_PERCENTILE = 0.85;

/** A second hue only counts as a real secondary if it is clearly distinct and
 *  actually present. Below these it is noise, and the caller derives one
 *  instead. */
const SECONDARY_MIN_HUE_SEPARATION = 60;
const SECONDARY_MIN_SHARE = 0.12;

/** Artwork URLs are content-addressed, so the bytes behind one never change.
 *  Long-lived by design. */
const IMAGE_REVALIDATE_SECONDS = 60 * 60 * 24 * 30;
const IMAGE_TIMEOUT_MS = 5_000;

/** Bounded so a long-running server can't accumulate one entry per title ever
 *  viewed. Entries are tiny (two OKLCH triples). */
const CACHE_MAX_ENTRIES = 256;

export interface ExtractedPalette {
  primary: Oklch;
  /** Null when the artwork offers no second hue that is both distinct enough
   *  and present enough to be a deliberate choice rather than noise. */
  secondary: Oklch | null;
}

/* ---------------------------------------------------------------------------
 * Cache
 * ------------------------------------------------------------------------ */

/**
 * Process-local LRU over the *derived* palette, on top of Next's fetch data
 * cache holding the raw bytes. Deliberately not `"use cache"`: that directive
 * requires enabling `cacheComponents` in next.config.ts, which changes caching
 * semantics for the entire application — far too much blast radius to take on
 * for one visual feature. `unstable_cache` is the other option and is
 * deprecated in Next 16.
 *
 * A cold server instance re-derives once, which costs single-digit
 * milliseconds. That is an acceptable price for not reshaping the app's
 * caching model.
 */
const cache = new Map<string, ExtractedPalette | null>();

function cacheGet(key: string): { hit: true; value: ExtractedPalette | null } | { hit: false } {
  if (!cache.has(key)) return { hit: false };
  const value = cache.get(key) ?? null;
  // Re-insert to move to the most-recently-used end.
  cache.delete(key);
  cache.set(key, value);
  return { hit: true, value };
}

function cacheSet(key: string, value: ExtractedPalette | null): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/* ---------------------------------------------------------------------------
 * Histogram
 * ------------------------------------------------------------------------ */

interface HueBin {
  /** Summed chroma^2 — see the weighting note in `buildPalette`. */
  weight: number;
  sinSum: number;
  cosSum: number;
  /** Kept as (L, C) PAIRS, not two parallel arrays. See `toCandidate`. */
  pixels: { L: number; C: number }[];
}

function buildPalette(pixels: Buffer): ExtractedPalette | null {
  const bins: HueBin[] = Array.from({ length: HUE_BINS }, () => ({
    weight: 0,
    sinSum: 0,
    cosSum: 0,
    pixels: [],
  }));

  let chromatic = 0;
  let usable = 0;

  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const { L, C, h } = rgbToOklch([pixels[i], pixels[i + 1], pixels[i + 2]]);
    if (L < MIN_PIXEL_L || L > MAX_PIXEL_L) continue;
    usable++;
    if (C < MIN_PIXEL_C) continue;
    chromatic++;

    const bin = bins[Math.floor((h / 360) * HUE_BINS) % HUE_BINS];
    // Weight by chroma SQUARED so a small vivid region outranks a large muted
    // one. A poster is "about" its saturated accents, not its grey mass.
    const weight = C * C;
    bin.weight += weight;
    bin.sinSum += Math.sin((h * Math.PI) / 180) * weight;
    bin.cosSum += Math.cos((h * Math.PI) / 180) * weight;
    bin.pixels.push({ L, C });
  }

  if (usable === 0 || chromatic / usable < MIN_CHROMATIC_SHARE) return null;

  const live = bins.filter((bin) => bin.weight > 0);
  if (live.length === 0) return null;

  const totalWeight = live.reduce((sum, bin) => sum + bin.weight, 0);
  const ranked = [...live].sort((a, b) => b.weight - a.weight);

  const toCandidate = (bin: HueBin) => {
    // Rank pixels by chroma and take ONE real pixel — using both its lightness
    // and its chroma together. Percentiling L and C independently would
    // synthesize a colour from two different pixels that may appear nowhere in
    // the artwork, and in practice it picks the palest highlights of the hue:
    // it turned Spider-Verse's night-blue into a washed-out #add6fe by pairing
    // the 85th-percentile lightness with an unrelated chroma. A vivid pixel's
    // own lightness is the honest answer.
    const ranked = [...bin.pixels].sort((a, b) => a.C - b.C);
    const pick = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * CHROMA_PERCENTILE))];
    return {
      colour: {
        L: pick.L,
        C: pick.C,
        // Circular mean, so a hue straddling the 0/360 seam doesn't average to
        // its opposite.
        h: (((Math.atan2(bin.sinSum, bin.cosSum) * 180) / Math.PI) + 360) % 360,
      } satisfies Oklch,
      share: bin.weight / totalWeight,
    };
  };

  const primary = toCandidate(ranked[0]);
  const secondary = ranked
    .slice(1)
    .map(toCandidate)
    .find(
      (candidate) =>
        candidate.share >= SECONDARY_MIN_SHARE &&
        Math.min(
          Math.abs(candidate.colour.h - primary.colour.h),
          360 - Math.abs(candidate.colour.h - primary.colour.h),
        ) >= SECONDARY_MIN_HUE_SEPARATION,
    );

  return { primary: primary.colour, secondary: secondary?.colour ?? null };
}

/* ---------------------------------------------------------------------------
 * Public entry point
 * ------------------------------------------------------------------------ */

/**
 * Fetches and samples one artwork URL.
 *
 * Never throws — a theming failure must degrade to the brand palette, never
 * take down a title page. The two failure classes are handled differently on
 * purpose:
 *
 *   - A successful decode that finds no usable hue is a PERMANENT property of
 *     that image, so it is cached (as null) and never retried.
 *   - A fetch or decode error is TRANSIENT, so it is deliberately not cached —
 *     a momentary network blip must not poison the palette for the lifetime of
 *     the process.
 */
export async function extractPalette(imageUrl: string): Promise<ExtractedPalette | null> {
  const cached = cacheGet(imageUrl);
  if (cached.hit) return cached.value;

  let buffer: Buffer;
  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      next: { revalidate: IMAGE_REVALIDATE_SECONDS },
    });
    if (!response.ok) return null;
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return null; // transient — not cached
  }

  try {
    const { data, info } = await sharp(buffer)
      .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: "fill" })
      .toColorspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // removeAlpha() should guarantee 3, but a CMYK or otherwise exotic source
    // would break the stride assumption in buildPalette and silently produce
    // garbage colours. Bail instead.
    if (info.channels !== 3) return null;

    const palette = buildPalette(data);
    cacheSet(imageUrl, palette); // permanent property of this image
    return palette;
  } catch {
    return null; // transient — not cached
  }
}
