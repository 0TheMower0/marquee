import { PosterImage } from "@/components/title/poster-image";
import type { CastMember, CrewMember, CrewRole } from "@/lib/content/types";
import { derivePlaceholderArt } from "@/lib/content/shared/placeholder";

/**
 * Cast + key crew for the title detail page. A Server Component — everything
 * here is static per-page data, and the only client-side piece
 * (load-failure handling on a photo) already lives inside `PosterImage`.
 *
 * Renders NOTHING — no heading, no empty box — when both lists are empty,
 * same precedent as the Genres section on this page. Cast and crew are
 * independent within that: a title with crew but no cast (or vice versa)
 * renders just the half it has.
 */

/** TMDB can return dozens of billed cast members; this is a detail page; not
 *  a full credits scrape. Already sorted by billing order, so slicing keeps
 *  the leads and drops the deep bench. */
const CAST_DISPLAY_LIMIT = 20;

const ROLE_ORDER: CrewRole[] = ["creator", "director", "writer"];
const ROLE_LABEL: Record<CrewRole, [string, string]> = {
  // [singular, plural]
  creator: ["Creator", "Creators"],
  director: ["Director", "Directors"],
  writer: ["Writer", "Writers"],
};

/** Cast and crew photos share one fallback system with the poster/backdrop
 *  work in Step 1 — same gradient-plus-monogram philosophy, just circular.
 *  Namespaced by person id (not cast/crew-specific) so the same real person
 *  gets the same gradient whether they show up as a director or an actor. */
function personPlaceholder(id: string) {
  return derivePlaceholderArt(`person-${id}`);
}

function CrewRows({ crew }: { crew: CrewMember[] }) {
  if (crew.length === 0) return null;

  const groups = ROLE_ORDER.map((role) => ({
    role,
    members: crew.filter((member) => member.role === role),
  })).filter((group) => group.members.length > 0);

  return (
    <dl className="mb-6 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
      {groups.map(({ role, members }) => (
        <div key={role}>
          <dt className="text-meta text-accent uppercase">
            {ROLE_LABEL[role][members.length > 1 ? 1 : 0]}
          </dt>
          <dd className="text-body-sm text-fg mt-1">
            {members.map((member) => member.name).join(", ")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CastRail({ cast }: { cast: CastMember[] }) {
  if (cast.length === 0) return null;
  const shown = cast.slice(0, CAST_DISPLAY_LIMIT);

  return (
    <ul
      aria-label="Cast"
      className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      {shown.map((member) => (
        <li key={member.id} className="w-20 shrink-0 snap-start text-center sm:w-24">
          <div className="border-line-subtle relative mx-auto size-20 overflow-hidden rounded-full border sm:size-24">
            <PosterImage
              src={member.profileUrl}
              alt=""
              name={member.name}
              placeholder={personPlaceholder(member.id)}
              sizes="96px"
              initialsClassName="text-lg"
            />
          </div>
          <p className="text-body-sm text-fg mt-2 truncate" title={member.name}>
            {member.name}
          </p>
          {member.character && (
            <p
              className="text-meta-sm text-accent truncate"
              title={member.character}
            >
              {member.character}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CastCrewSection({
  cast,
  crew,
}: {
  cast: CastMember[];
  crew: CrewMember[];
}) {
  if (cast.length === 0 && crew.length === 0) return null;

  return (
    <section aria-labelledby="cast-crew-heading">
      <h2
        id="cast-crew-heading"
        className="font-display text-display-md text-fg uppercase"
      >
        Cast &amp; Crew
      </h2>
      <div className="mt-4">
        <CrewRows crew={crew} />
        <CastRail cast={cast} />
      </div>
    </section>
  );
}
