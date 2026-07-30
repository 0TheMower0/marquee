import { ProviderLogo } from "@/components/title/provider-logo";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import type { WatchProvider, WatchProviderType } from "@/lib/content/types";

/**
 * "Where to Watch" — renders nothing at all, not an empty box, when
 * `providers` is []. That is the common case in practice: mock mode always
 * returns [] (no real availability data to fabricate — see the note in
 * lib/content/mock/index.ts), and plenty of real titles have no listed
 * availability in a given region either.
 *
 * Region: fetched server-side by the caller against `getContentProvider()`'s
 * own default ("US" — see DEFAULT_REGION in lib/content/tmdb/index.ts). This
 * does NOT detect the visitor's actual region — that would need geo-IP
 * infrastructure (e.g. a platform header) this project doesn't have yet. The
 * plumbing is region-*capable* (the interface, the API route, and this
 * component all accept/pass a region), it just isn't region-*aware* of any
 * particular visitor today. Worth revisiting if that gap ever matters enough.
 *
 * JustWatch attribution (CLAUDE.md, Legal / attribution): TMDB sources this
 * data from JustWatch, and their terms require a visible credit wherever it
 * renders. Because the whole section is skipped when there is nothing to
 * show, the credit is skipped right along with it — never displaying data
 * without the credit, and never displaying the credit without data.
 */

const TYPE_ORDER: WatchProviderType[] = ["stream", "rent", "buy"];

const TYPE_LABEL: Record<WatchProviderType, string> = {
  stream: "Stream",
  rent: "Rent",
  buy: "Buy",
};

/** Streaming (included in a subscription) is the most actionable option, so
 *  it gets the primary accent; rent/buy step down in visual weight. All three
 *  route through Badge's semantic variants, so they re-tint with the rest of
 *  the page rather than being hardcoded colours. */
const TYPE_BADGE_VARIANT: Record<WatchProviderType, BadgeVariant> = {
  stream: "accent",
  rent: "secondary",
  buy: "outline",
};

export function WatchProvidersSection({ providers }: { providers: WatchProvider[] }) {
  if (providers.length === 0) return null;

  // A provider can legitimately appear in more than one group (streamable AND
  // rentable there are distinct offers — see the note in tmdb/normalize.ts),
  // so this groups by type rather than de-duplicating by id.
  const groups = TYPE_ORDER.map((type) => ({
    type,
    items: providers.filter((provider) => provider.type === type),
  })).filter((group) => group.items.length > 0);

  return (
    <section aria-labelledby="watch-heading">
      <h2 id="watch-heading" className="font-display text-display-md text-fg uppercase">
        Where to Watch
      </h2>

      <div className="mt-4 space-y-4">
        {groups.map(({ type, items }) => (
          <div key={type}>
            <Badge variant={TYPE_BADGE_VARIANT[type]} className="mb-2">
              {TYPE_LABEL[type]}
            </Badge>
            <ul className="flex flex-wrap gap-2">
              {items.map((provider) => (
                <li key={provider.id}>
                  <ProviderLogo provider={provider} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="text-meta-sm text-fg-subtle mt-4">
        Powered by{" "}
        <a
          href="https://www.justwatch.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-fg-muted underline underline-offset-2"
        >
          JustWatch
        </a>
      </p>
    </section>
  );
}
