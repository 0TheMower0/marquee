import { formatAirDate } from "@/lib/utils/dates";
import { headlineFor, showsHours, type YirData } from "@/lib/yir";

/**
 * Renders the shareable card to a PNG, on-device, with the canvas 2D API.
 *
 * ============================================================================
 * WHY AN IMAGE AND NOT A PUBLIC LINK
 * ============================================================================
 * A link would make Year in Review the FIRST feature in this app to upload
 * personal data to a server. It would need an account (most users are signed
 * out), a new public-read surface with its own RLS, and it would directly
 * break the "works offline from local data" requirement. It would also create
 * a URL that outlives the user's intent — shareable long after they wish it
 * weren't.
 *
 * An image is generated here, from data already on the device, and leaves
 * only if the user hands it to someone. That gives the strongest privacy
 * guarantee available: **what you see is exactly what you share.** There is
 * no server copy, nothing to revoke, and no way for the artifact to contain
 * something the user did not look at first.
 *
 * ============================================================================
 * 1080x1350 (4:5), NOT 9:16
 * ============================================================================
 * The brief was group chats. Story-shaped 9:16 images get centre-cropped in
 * chat previews, which would cut the headline. 4:5 is the tallest ratio that
 * previews intact essentially everywhere, and it still reads as a "card"
 * rather than a screenshot.
 *
 * Drawn directly rather than via html2canvas: that library is a heavy
 * dependency with well-known fidelity gaps, and this project already
 * hand-rolls its icons and charts for the same reasons. Canvas also gives
 * exact control at a fixed size, which a DOM screenshot at 375px cannot.
 */

const WIDTH = 1080;
const HEIGHT = 1350;

/** Matches the palette in app/globals.css. Duplicated as literals rather than
 *  parsed out of CSS custom properties — `getComputedStyle` would work but
 *  would silently produce a differently-coloured image if this ever rendered
 *  detached from the document. */
const INK = "#0b0b0e";
const INK_SUNKEN = "#060608";
const GOLD = "#e8b33c";
const FG = "#f5f3ef";
const FG_MUTED = "#a8a5a0";

/**
 * Waits for the display face before drawing.
 *
 * Canvas silently falls back to a default font when the requested family is
 * not yet loaded — no error, just a card that looks wrong. `next/font`
 * self-hosts Bebas Neue under a hashed family name exposed via the
 * `--font-bebas` custom property, so the actual family is read from the
 * document rather than hardcoded.
 *
 * Returns whichever families are safe to use. If loading fails the card still
 * renders, in the fallback face — a plain-looking image beats no image.
 */
async function loadFonts(): Promise<{ display: string; body: string }> {
  const styles = getComputedStyle(document.documentElement);
  const display = styles.getPropertyValue("--font-bebas").trim() || "sans-serif";
  const body = styles.getPropertyValue("--font-inter").trim() || "sans-serif";

  try {
    await Promise.all([
      document.fonts.load(`700 96px ${display}`),
      document.fonts.load(`400 32px ${body}`),
      document.fonts.ready,
    ]);
  } catch {
    /* fall through — the card renders in whatever is available */
  }

  return { display, body };
}

function wrap(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The facts on the card, in the order they are drawn.
 *
 * Built from `YirData` only — the same computed object the on-screen deck
 * renders, which reads `score` but never `note`, and never touches lists at
 * all. There is no path from a private field to this image because there is
 * no private field in the input.
 */
function statLines(data: YirData): string[] {
  const lines: string[] = [];
  const { movies, episodes } = data.tally;

  if (movies > 0) lines.push(`${movies} ${movies === 1 ? "film" : "films"}`);
  if (episodes > 0) lines.push(`${episodes} ${episodes === 1 ? "episode" : "episodes"}`);
  if (showsHours(data)) lines.push(`~${data.tally.approxHours} hours`);
  if (data.decades) lines.push(`${data.decades.count} decades`);
  if (data.genres) lines.push(data.genres.topGenre);
  if (data.topShow) lines.push(data.topShow.name);

  return lines.slice(0, 6);
}

export async function renderShareImage(data: YirData): Promise<Blob> {
  const { display, body } = await loadFonts();

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable in this browser.");

  // Background
  context.fillStyle = INK;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  // A gold band down the left edge — echoes the ticket identity without
  // needing the mask geometry, which does not translate to a flat card.
  context.fillStyle = GOLD;
  context.fillRect(0, 0, 16, HEIGHT);

  const left = 88;
  const maxWidth = WIDTH - left * 2;

  // Eyebrow
  context.fillStyle = FG_MUTED;
  context.font = `400 30px ${body}`;
  context.fillText("MARQUEE · YOUR LAST 12 MONTHS", left, 140);

  // Date range — shown, never implied, so this is not mistaken for a
  // calendar-year summary. Formatted the same way as the on-screen opener
  // card rather than as raw ISO: caught by looking at the rendered PNG, where
  // "2025-08-12 — 2026-08-11" read like a log line next to friendly copy.
  context.fillStyle = FG_MUTED;
  context.font = `400 26px ${body}`;
  const from = formatAirDate(data.range.from) ?? data.range.from;
  const to = formatAirDate(data.range.to) ?? data.range.to;
  context.fillText(`${from} — ${to}`, left, 186);

  // Headline
  context.fillStyle = GOLD;
  context.font = `400 104px ${display}`;
  const headlineLines = wrap(context, headlineFor(data).toUpperCase(), maxWidth);
  let y = 340;
  for (const line of headlineLines.slice(0, 3)) {
    context.fillText(line, left, y);
    y += 108;
  }

  // Stats
  y += 40;
  for (const line of statLines(data)) {
    context.fillStyle = GOLD;
    context.fillRect(left, y - 14, 10, 10);
    context.fillStyle = FG;
    context.font = `400 44px ${body}`;
    context.fillText(line, left + 34, y);
    y += 74;
  }

  // Critic line — the most shareable single fact. Placed directly after the
  // stats rather than pinned to the bottom: anchoring it to HEIGHT left a
  // conspicuous dead band between the two whenever the stat list was short,
  // which is exactly the common case. Found by looking at the rendered PNG.
  if (data.critics && data.critics.persona !== "aligned") {
    context.fillStyle = FG_MUTED;
    context.font = `400 32px ${body}`;
    const verdict =
      data.critics.persona === "tough"
        ? `Rates ${Math.abs(data.critics.gap)} points below the crowd`
        : `Rates ${data.critics.gap} points above the crowd`;
    context.fillText(verdict, left, Math.min(y + 26, HEIGHT - 170));
  }

  // Footer
  context.fillStyle = INK_SUNKEN;
  context.fillRect(0, HEIGHT - 110, WIDTH, 110);
  context.fillStyle = FG_MUTED;
  context.font = `400 28px ${body}`;
  context.fillText("Tracked with Marquee", left, HEIGHT - 48);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      "image/png",
    );
  });
}

export type ShareOutcome = "shared" | "downloaded" | "failed";

/**
 * Hands the image to the OS share sheet, falling back to a download.
 *
 * `canShare({ files })` is checked rather than assumed: several browsers
 * expose `navigator.share` but reject file payloads, and calling it blindly
 * would throw after the user had already tapped.
 */
export async function shareImage(data: YirData): Promise<ShareOutcome> {
  let blob: Blob;
  try {
    blob = await renderShareImage(data);
  } catch (error) {
    console.warn("[marquee] could not render the share image", error);
    return "failed";
  }

  const file = new File([blob], "marquee-year-in-review.png", { type: "image/png" });

  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      // A user dismissing the share sheet rejects with AbortError. That is not
      // a failure and must not fall through to a surprise download.
      if (error instanceof Error && error.name === "AbortError") return "shared";
      console.warn("[marquee] share sheet failed, falling back to download", error);
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "marquee-year-in-review.png";
    link.click();
    URL.revokeObjectURL(url);
    return "downloaded";
  } catch (error) {
    console.warn("[marquee] could not download the share image", error);
    return "failed";
  }
}
