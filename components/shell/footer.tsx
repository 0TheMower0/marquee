import Image from "next/image";

/**
 * Required TMDB Developer attribution (see CLAUDE.md — Legal / attribution).
 *
 * The logo is the official horizontal wordmark SVG from
 * https://www.themoviedb.org/about/logos-attribution, saved locally at
 * public/tmdb-logo.svg. `width`/`height` below are that file's own viewBox
 * (489.04 x 35.4) — not eyeballed — so `h-4 w-auto` scales it down for
 * display without distorting the aspect ratio. Next auto-unoptimizes `.svg`
 * sources (see node_modules/next/dist/docs .../components/image.md), so no
 * `next.config.js` change was needed to render it.
 */
export function Footer() {
  return (
    <footer className="border-line-subtle text-fg-subtle text-meta-sm border-t px-6 py-8">
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="https://www.themoviedb.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 opacity-90 transition-opacity hover:opacity-100"
        >
          <Image
            src="/tmdb-logo.svg"
            alt="TMDB"
            width={489.04}
            height={35.4}
            // Required attribution, not decorative content — it must not be
            // deferred behind the default lazy-loading IntersectionObserver.
            priority
            className="h-4 w-auto"
          />
        </a>
        <p className="max-w-prose">
          This product uses the TMDB API but is not endorsed or certified by{" "}
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg-muted underline underline-offset-2"
          >
            TMDB
          </a>
          .
        </p>
      </div>
      <p className="mt-2 max-w-prose">
        Marquee is a free, non-commercial, ad-free project. Not affiliated
        with any streaming service.
      </p>
    </footer>
  );
}
