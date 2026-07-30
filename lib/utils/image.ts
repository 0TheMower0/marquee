/**
 * A tiny inline SVG matching a title's own placeholder gradient, used as
 * next/image's `blurDataURL`.
 *
 * Next can only auto-generate a blur placeholder for statically imported
 * local files — these are remote, runtime-determined TMDB URLs, so there is
 * no build-time hook to generate one from the real image. Hand-rolling this
 * from the SAME two gradient stops already used as the "no image" fallback
 * means loading and "no image" share one visual language instead of two: the
 * blur-up starts as the exact gradient the fallback would show, then
 * crossfades into the real photo once it arrives. No popping between a
 * generic gray box and the final image.
 */
export function blurDataUrl(gradientFrom: string, gradientTo: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="12">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${gradientFrom}"/>` +
    `<stop offset="100%" stop-color="${gradientTo}"/>` +
    `</linearGradient></defs>` +
    `<rect width="8" height="12" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
