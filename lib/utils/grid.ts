/**
 * The one definition of the title-grid column rhythm.
 *
 * `TitleGrid` and `SkeletonGrid` must lay out identically — the skeleton is a
 * Suspense fallback that gets swapped for the real grid mid-paint, and any
 * difference in column count shows up as a visible reflow at the exact moment
 * the user is looking at it. Importing one constant makes that impossible to
 * get wrong, rather than relying on two copies of the same string staying in
 * sync.
 */
export const TITLE_GRID_CLASS =
  "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

/**
 * How many skeleton cards to render while a FULL page of titles loads.
 *
 * Same argument as `TITLE_GRID_CLASS` one line up, extended from "the columns
 * must match" to "the row COUNT must match": both providers return 20 items
 * per page, and a 10-card skeleton meant the grid changed height on swap.
 *
 * Honest scope note, because this was first written claiming more than it
 * delivers: this was NOT the cause of Home's 0.645 CLS. Matching the count
 * changed that number by nothing at all — literally to sixteen decimal places
 * — which is what proved the hypothesis wrong and sent the investigation to
 * the trace, where the real culprit turned out to be the Up Next slot above
 * the grid (see `UpNextRail`). This constant is kept because a skeleton that
 * models the wrong row count is still wrong, not because it fixed the metric.
 *
 * Deliberately NOT used for search, whose result count is genuinely unknown
 * ahead of time: a 20-card skeleton collapsing to 3 matches would trade a
 * grow-shift for a shrink-shift and fix nothing. Search measures 0 today.
 */
export const TITLE_PAGE_SIZE = 20;

/**
 * next/image's `sizes` for a card in that exact grid — approximate on
 * purpose. `sizes` only needs to steer the browser toward the closest
 * candidate in the auto-generated `srcset`, not predict a card's rendered
 * width to the pixel, so this maps the column count at each breakpoint to a
 * vw fraction (halved/thirded/quartered for the 2/3/4-col tiers) rather than
 * accounting for the sidebar's fixed 224px offset or the gap's few pixels.
 * The `xl` tier is the one exception: above 1280px the grid sits inside
 * `max-w-7xl`, so the container stops growing with the viewport and a vw
 * fraction would keep requesting larger images for no reason — a fixed
 * upper bound (5 cols across a 1280px-capped, padded, sidebar-offset
 * container) is used instead.
 */
export const POSTER_GRID_SIZES =
  "(min-width: 1280px) 230px, (min-width: 1024px) 22vw, (min-width: 640px) 33vw, 50vw";
