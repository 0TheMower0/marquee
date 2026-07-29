/**
 * Two-letter monogram for a title, used as the fallback artwork mark wherever
 * no poster image exists — always in mock mode, and in tmdb mode whenever a
 * poster 404s.
 *
 * Leading articles are dropped so "The Godfather" reads as "G" rather than
 * "TG", which would collide with every other "The …" in the catalog.
 */
export function initialsFor(name: string): string {
  return name
    .replace(/^(the|a|an)\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
