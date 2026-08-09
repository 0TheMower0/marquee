/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * A plain `Promise.all` over everything at once opens one socket per item —
 * fine for 3 items, a real problem for 40 (the exact "someone tracking 40
 * shows shouldn't trigger 40 calls on page load" shape lib/schedule was built
 * against). A sequential loop is safe but slow. This is the middle ground.
 *
 * Extracted from lib/import/resolve.ts (Phase 7 Step 1, where it capped
 * upstream lookups during CSV resolution) rather than re-implemented for
 * lib/schedule's per-show season fetches — same shape, same reasoning, and a
 * second hand-written copy is exactly the kind of duplicated logic that has
 * drifted out of sync elsewhere in this codebase before.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
