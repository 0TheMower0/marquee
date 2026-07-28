import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Our custom font-size scale, declared to tailwind-merge.
 *
 * THIS IS NOT OPTIONAL CONFIGURATION — without it the library silently
 * deletes text colours.
 *
 * tailwind-merge resolves conflicts by bucketing classes into groups. Out of
 * the box it only knows Tailwind's stock sizes (text-sm, text-lg, …), so it
 * falls back to treating any other `text-*` as a COLOUR. That puts
 * `text-display-sm` and `text-accent` in the same bucket, and since only the
 * last member of a bucket survives, `cn("text-accent", "text-display-sm")`
 * returned just `text-display-sm` — the button rendered at the right size in
 * the wrong colour, with no error anywhere.
 *
 * Listing the sizes here splits them back into the `font-size` group, so a
 * size and a colour can coexist. Keep this in sync with the `--text-*` tokens
 * in app/globals.css: adding a size token there and forgetting it here
 * reintroduces the bug.
 */
const FONT_SIZES = [
  "display-2xl",
  "display-xl",
  "display-lg",
  "display-md",
  "display-sm",
  "body-lg",
  "body",
  "body-sm",
  "meta",
  "meta-sm",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
    },
  },
});

/**
 * Merge Tailwind classes so a `className` prop can actually override a
 * component's defaults. Plain string concatenation doesn't work for this:
 * CSS resolves conflicts by stylesheet order, not by order in the class
 * attribute, so `"bg-surface" + "bg-accent"` yields whichever Tailwind emitted
 * later — unpredictable. twMerge resolves the conflict up front, keeping only
 * the last of each conflicting group.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
