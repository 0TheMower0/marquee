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
