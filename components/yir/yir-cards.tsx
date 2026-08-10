"use client";

import { formatAirDate } from "@/lib/utils/dates";
import { headlineFor, isThinYear, showsHours, type YirCardId, type YirData } from "@/lib/yir";

/**
 * The individual cards. 375px first throughout — this is viewed on phones
 * almost exclusively, so every card is designed at one column and simply gets
 * more breathing room on larger screens rather than a different layout.
 *
 * Each card is a self-contained statement. They are read one at a time, and
 * any of them may be absent (see `selectCards`), so none may depend on
 * another having been shown.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourLabel(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "midday";
  const period = hour < 12 ? "am" : "pm";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}${period}`;
}

export function YirCard({ id, data }: { id: YirCardId; data: YirData }) {
  switch (id) {
    case "opener":
      return <OpenerCard data={data} />;
    case "tally":
      return <TallyCard data={data} />;
    case "decades":
      return <DecadesCard data={data} />;
    case "genres":
      return <GenresCard data={data} />;
    case "topShow":
      return <TopShowCard data={data} />;
    case "rhythm":
      return <RhythmCard data={data} />;
    case "critics":
      return <CriticsCard data={data} />;
    case "closer":
      return <CloserCard data={data} />;
  }
}

function Card({
  children,
  label,
}: {
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className="bg-surface border-line-subtle flex min-h-[18rem] flex-col justify-center gap-3 rounded-lg border p-6"
    >
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-meta-sm text-fg-subtle uppercase">{children}</p>;
}

function Big({ children }: { children: React.ReactNode }) {
  // Bebas has no lowercase; every use of font-display here is a heading or a
  // number, never body copy — the rule CLAUDE.md sets for that face.
  return (
    <p className="font-display text-display-2xl text-accent leading-none uppercase">{children}</p>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm text-fg-muted max-w-prose">{children}</p>;
}

/* -------------------------------------------------------------------------- */

function OpenerCard({ data }: { data: YirData }) {
  return (
    <Card label="Your last 12 months">
      <Eyebrow>Marquee</Eyebrow>
      <p className="font-display text-display-xl text-fg leading-none uppercase">
        Your last
        <br />
        12 months
      </p>
      {/* The date range is shown, not implied. This is deliberately NOT a
          calendar-year summary and must never be mistaken for one. */}
      <p className="text-meta text-fg-subtle">
        {formatAirDate(data.range.from)} &ndash; {formatAirDate(data.range.to)}
      </p>
      {data.firstWatch && (
        <Body>
          It started with <strong className="text-fg">{data.firstWatch.name}</strong>.
        </Body>
      )}
    </Card>
  );
}

function TallyCard({ data }: { data: YirData }) {
  const { movies, episodes, shows } = data.tally;
  const thin = isThinYear(data);

  const parts: string[] = [];
  if (movies > 0) parts.push(`${movies} ${movies === 1 ? "film" : "films"}`);
  if (episodes > 0) parts.push(`${episodes} ${episodes === 1 ? "episode" : "episodes"}`);
  if (shows > 0) parts.push(`${shows} ${shows === 1 ? "show" : "shows"}`);

  return (
    <Card label="What you watched">
      <Eyebrow>You watched</Eyebrow>
      {/* A thin year states the same facts without a giant number, because
          "6" set in 48px reads as a scoreboard nobody won. */}
      {thin ? (
        <p className="text-body-lg text-fg">{parts.join(" · ")}</p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {movies > 0 && <Stat value={movies} label={movies === 1 ? "film" : "films"} />}
          {episodes > 0 && (
            <Stat value={episodes} label={episodes === 1 ? "episode" : "episodes"} />
          )}
        </div>
      )}

      {showsHours(data) && (
        // "About" is load-bearing: movie runtimes are unknown for older
        // records and per-episode runtime is not stored at all, so this is an
        // estimate and says so rather than implying a measurement.
        <Body>That&rsquo;s about {data.tally.approxHours} hours.</Body>
      )}

      {data.provenance.importDominated && (
        // The honest framing for someone who imported years of history: a
        // diary entry is something you watched, but the IMPORT is not a
        // viewing year, and the card must not dress one up as the other.
        <Body>
          Most of this came from imported history rather than watching logged as it
          happened, so times of day are missing.
        </Body>
      )}
    </Card>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-display text-display-2xl text-accent leading-none">{value}</span>
      <span className="text-meta text-fg-muted uppercase">{label}</span>
    </span>
  );
}

function DecadesCard({ data }: { data: YirData }) {
  const decades = data.decades!;
  return (
    <Card label="Decades">
      <Eyebrow>You reached back</Eyebrow>
      <Big>
        {decades.count} {decades.count === 1 ? "decade" : "decades"}
      </Big>
      <Body>
        From {decades.oldestYear} to {decades.newestYear} &mdash; a span of{" "}
        {decades.newestYear - decades.oldestYear} years.
      </Body>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {decades.decades.map((decade) => (
          <span
            key={decade}
            className="bg-accent/15 text-accent text-meta-sm rounded-sm px-2 py-0.5"
          >
            {decade}s
          </span>
        ))}
      </div>
    </Card>
  );
}

function GenresCard({ data }: { data: YirData }) {
  const genres = data.genres!;
  return (
    <Card label="Genres">
      <Eyebrow>Your taste</Eyebrow>
      {genres.persona === "omnivore" ? (
        <>
          <Big>A bit of everything</Big>
          <Body>
            {genres.distinctGenres} different genres, and no single favourite. Hard to
            pin down.
          </Body>
        </>
      ) : genres.persona === "specialist" ? (
        <>
          <Big>{genres.topGenre}</Big>
          <Body>
            {Math.round(genres.topGenreShare * 100)}% of what you watched. You know what
            you like.
          </Body>
        </>
      ) : (
        <>
          <Big>{genres.topGenre}</Big>
          <Body>
            Your most-watched genre, across {genres.distinctGenres} you tried in total.
          </Body>
        </>
      )}
    </Card>
  );
}

function TopShowCard({ data }: { data: YirData }) {
  const show = data.topShow!;
  return (
    <Card label="Your show">
      <Eyebrow>Your show</Eyebrow>
      <p className="font-display text-display-xl text-fg leading-none uppercase">{show.name}</p>
      <Body>
        {show.episodes} {show.episodes === 1 ? "episode" : "episodes"} in the last 12 months.
      </Body>
    </Card>
  );
}

function RhythmCard({ data }: { data: YirData }) {
  const rhythm = data.rhythm!;
  return (
    <Card label="When you watch">
      <Eyebrow>When you watch</Eyebrow>
      <Big>
        {WEEKDAYS[rhythm.peakWeekday]}
        <br />
        {hourLabel(rhythm.peakHour)}
      </Big>
      <Body>Your most common time to press play.</Body>
      {rhythm.excluded > rhythm.sampleSize && (
        // Bulk marks and untimed imports cannot describe a viewing time, and
        // when they outnumber the real data the reader deserves to know the
        // claim rests on a subset.
        <p className="text-meta-sm text-fg-subtle">
          Based on {rhythm.sampleSize} of {rhythm.sampleSize + rhythm.excluded} entries &mdash;
          the rest were bulk-marked or imported without a time.
        </p>
      )}
    </Card>
  );
}

function CriticsCard({ data }: { data: YirData }) {
  const critics = data.critics!;
  const biggest = critics.deltas[0];

  return (
    <Card label="You versus the crowd">
      <Eyebrow>You vs the crowd</Eyebrow>
      {critics.persona === "aligned" ? (
        <Big>Dead on</Big>
      ) : (
        <Big>
          {critics.gap > 0 ? "+" : ""}
          {critics.gap}
        </Big>
      )}
      <Body>
        {critics.persona === "tough" &&
          `You rate ${Math.abs(critics.gap)} points below everyone else. A tough critic.`}
        {critics.persona === "generous" &&
          `You rate ${critics.gap} points above everyone else. Easily delighted.`}
        {critics.persona === "aligned" &&
          "Your scores track the crowd almost exactly. Suspiciously reasonable."}
      </Body>

      <dl className="mt-1 space-y-1">
        <Disagreement label="Biggest disagreement" item={biggest} />
        {critics.outlier && <Disagreement label="Except for" item={critics.outlier} />}
      </dl>
    </Card>
  );
}

function Disagreement({
  label,
  item,
}: {
  label: string;
  item: { name: string; you: number; crowd: number };
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-meta-sm text-fg-subtle uppercase">{label}</dt>
      <dd className="text-body-sm text-fg text-right">
        {item.name}{" "}
        <span className="text-fg-subtle">
          ({item.you} vs {item.crowd})
        </span>
      </dd>
    </div>
  );
}

function CloserCard({ data }: { data: YirData }) {
  return (
    <Card label="Summary">
      <Eyebrow>In a word</Eyebrow>
      <p className="font-display text-display-xl text-accent leading-none uppercase">
        {headlineFor(data)}
      </p>
      {data.activeDays > 0 && (
        <Body>
          You watched something on {data.activeDays}{" "}
          {data.activeDays === 1 ? "day" : "days"}
          {data.longestStreak > 1 && `, ${data.longestStreak} of them in a row`}.
        </Body>
      )}
    </Card>
  );
}
