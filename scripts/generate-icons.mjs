/**
 * Generates the PWA icon set into `public/`.
 *
 * Run with `npm run icons`. Committed and re-runnable on purpose: the outputs
 * are PNGs, which nobody can meaningfully edit or review in a diff, so the
 * SOURCE OF TRUTH is this file's geometry and the PNGs are build artifacts
 * that happen to be checked in (they must be, since `public/` is served
 * as-is and there is no image pipeline at request time).
 *
 * ============================================================================
 * WHY GEOMETRY AND NOT TEXT
 * ============================================================================
 * The obvious icon is the Bebas Neue "M" from the sidebar wordmark. Bebas is
 * self-hosted by `next/font` at build time, which means its actual font file
 * lives in `.next/` under a hashed name — not somewhere a standalone script
 * can reliably resolve, and not something to vendor a second copy of just for
 * this. So the mark is drawn as pure geometry: a ticket silhouette echoing
 * `.ticket-surface` (app/globals.css) with an M built from four straight
 * strokes. No font dependency, and it stays editable by changing numbers here.
 *
 * Colours come from the palette in app/globals.css. They are duplicated as
 * literals below rather than parsed out of the CSS — a script that parsed
 * globals.css would break the moment that file was reformatted, to save a
 * two-line edit that happens approximately never.
 *
 * See docs/phase-5-pwa-design.md §6 for why this is four files and not the
 * usual nine.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public");

/** --ink-900 (sunken) and --gold-400 (primary accent), app/globals.css. */
const INK = "#060608";
const GOLD = "#e8b33c";

/**
 * Fraction of the canvas the ticket occupies.
 *
 * `maskable` is much smaller because Android crops a maskable icon to an
 * arbitrary shape and only guarantees the centre 80% circle survives. Content
 * sized for the standard icon would have its notches and corners shaved off
 * by a circular mask. Two renders of the same geometry at two scales is the
 * whole difference between the variants — see docs/phase-5-pwa-design.md §6.
 */
const SCALE = {
  standard: 0.82,
  maskable: 0.58,
};

/**
 * One icon as an SVG string, drawn in a `size`x`size` viewBox.
 *
 * The notches and perforations are painted in the BACKGROUND colour on top of
 * the gold rather than subtracted from its path. That is legitimate here only
 * because every icon in this set is fully opaque — a transparent variant would
 * show the "holes" as gold. Stated rather than assumed, since the CSS version
 * of this shape (.ticket-surface) goes to real trouble with `mask-composite`
 * precisely so it can sit on any background.
 */
function ticketSvg(size, scale) {
  const cx = size / 2;
  const cy = size / 2;

  // Portrait, echoing TicketCard's 2:3 poster proportions.
  const th = size * scale;
  const tw = th * 0.74;
  const x0 = cx - tw / 2;
  const y0 = cy - th / 2;
  const r = tw * 0.1;

  // The tear line, and the notches/perforations that sit on it. 0.66 keeps the
  // stub visibly smaller than the main body, as on the real card.
  const tearY = y0 + th * 0.66;
  const notchR = tw * 0.1;
  const perfR = tw * 0.028;
  const perfGap = perfR * 4;

  // Perforation dots march outward from the centre so the row stays
  // symmetrical at any width, and stop short of the notches.
  const perfLimit = tw / 2 - notchR - perfR * 2;
  const dots = [];
  for (let offset = 0; offset <= perfLimit; offset += perfGap) {
    if (offset === 0) dots.push(cx);
    else dots.push(cx - offset, cx + offset);
  }

  // M as four straight strokes with mitred joins: up the left stem, down to
  // the middle vertex, up to the right apex, down the right stem. The middle
  // vertex stops at 58% so the M reads as condensed rather than square.
  const mh = th * 0.3;
  const mw = tw * 0.52;
  const mx = cx - mw / 2;
  const my = y0 + th * 0.16;
  const stroke = mw * 0.2;
  const mPath = `M ${mx} ${my + mh} L ${mx} ${my} L ${cx} ${my + mh * 0.58} L ${mx + mw} ${my} L ${mx + mw} ${my + mh}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${INK}"/>
  <rect x="${x0}" y="${y0}" width="${tw}" height="${th}" rx="${r}" fill="${GOLD}"/>
  <circle cx="${x0}" cy="${tearY}" r="${notchR}" fill="${INK}"/>
  <circle cx="${x0 + tw}" cy="${tearY}" r="${notchR}" fill="${INK}"/>
  ${dots.map((x) => `<circle cx="${x}" cy="${tearY}" r="${perfR}" fill="${INK}"/>`).join("\n  ")}
  <path d="${mPath}" fill="none" stroke="${INK}" stroke-width="${stroke}" stroke-linejoin="miter" stroke-linecap="butt"/>
</svg>`;
}

/**
 * `apple-touch-icon` uses the STANDARD layout, not the maskable one. iOS
 * ignores `purpose: "maskable"` entirely and applies its own fixed rounded-
 * square mask, which trims far less than Android's circle — rendering the
 * padded maskable art there would just look small and lost.
 */
const TARGETS = [
  { file: "icon-192.png", size: 192, scale: SCALE.standard },
  { file: "icon-512.png", size: 512, scale: SCALE.standard },
  { file: "icon-512-maskable.png", size: 512, scale: SCALE.maskable },
  { file: "apple-touch-icon.png", size: 180, scale: SCALE.standard },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const { file, size, scale } of TARGETS) {
    // Rendered at 4x and downsampled: sharp rasterizes SVG at the requested
    // pixel size, and the perforation dots are small enough at 180px that
    // rasterizing them directly leaves them muddy. Supersampling costs
    // milliseconds in a script nobody runs in a loop.
    const svg = ticketSvg(size * 4, scale);
    const png = await sharp(Buffer.from(svg))
      .resize(size, size, { fit: "fill" })
      // Flattened onto INK so the output has NO alpha channel at all.
      // The notches and perforations are painted in the background colour
      // rather than subtracted (see `ticketSvg`), which is only correct while
      // these files are opaque — flattening makes that an encoded property
      // instead of something that happens to be true. It also matters on iOS,
      // which composites a transparent `apple-touch-icon` onto white.
      .flatten({ background: INK })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await writeFile(join(OUT_DIR, file), png);
    console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
  }

  // The SVG source of the standard mark, kept alongside the PNGs so the shape
  // is reviewable as text and usable anywhere an SVG is preferable.
  await writeFile(join(OUT_DIR, "icon.svg"), `${ticketSvg(512, SCALE.standard)}\n`);
  console.log("icon.svg".padEnd(24) + " vector");
}

await main();
