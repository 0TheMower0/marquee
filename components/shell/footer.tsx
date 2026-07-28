/**
 * Required TMDB Developer attribution (see CLAUDE.md — Legal / attribution).
 *
 * TMDB's terms also want their logo image alongside this text. That is
 * deliberately NOT included yet: it means downloading and committing an
 * actual image asset from TMDB, which is a real file-acquisition decision,
 * not a styling one — flagged to the user rather than silently fetched.
 * Text-only attribution is a legitimate interim state; add the logo before
 * treating this as launch-ready.
 */
export function Footer() {
  return (
    <footer className="border-line-subtle text-fg-subtle text-meta-sm border-t px-6 py-8">
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
      <p className="mt-2 max-w-prose">
        Marquee is a free, non-commercial, ad-free project. Not affiliated
        with any streaming service.
      </p>
    </footer>
  );
}
