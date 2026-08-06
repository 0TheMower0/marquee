"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { useSync } from "@/lib/sync";
import type { MergeSummary } from "@/lib/sync";

/**
 * The post-merge summary — design doc §6.4.
 *
 * ============================================================================
 * THIS IS WHAT MAKES MAX-PROGRESS STATUS MERGING ACCEPTABLE
 * ============================================================================
 * §6.3 accepts that the merge can resurrect a status the user deliberately
 * downgraded — a show moved back to "watchlist" on one device may return to
 * "watched". That trade is only defensible because of this panel: a
 * resurrection becomes something the user was TOLD about, rather than
 * something they stumble on months later and cannot explain.
 *
 * So the status list is the most important thing here, not the counts. The
 * counts are reassurance; the differences are the actual disclosure.
 *
 * §6.4 also asks for it to be re-openable rather than a one-shot toast,
 * "because the merge happens at the exact moment a user is busy doing
 * something else (signing in) and is the moment they are least likely to read
 * carefully." Dismissing marks it acknowledged; the record itself is kept.
 */
export function MergeSummaryPanel() {
  const sync = useSync();
  if (!sync?.mergeSummary) return null;

  return (
    <MergeSummaryCard
      summary={sync.mergeSummary}
      onDismiss={() => void sync.dismissSummary()}
    />
  );
}

export function MergeSummaryCard({
  summary,
  onDismiss,
}: {
  summary: MergeSummary;
  onDismiss?: () => void;
}) {
  const { counts, statusDifferences, noteConcatenations, scoreDifferences } = summary;

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Your data was merged</CardTitle>
      </CardHeader>

      <CardBody className="space-y-5">
        <p>
          This device&rsquo;s library and your account have been combined.
          Nothing was deleted from either side.
        </p>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Titles" value={counts.titlesUploaded + counts.titlesReceived} />
          <Stat label="Episodes" value={counts.episodesMerged} />
          <Stat label="Ratings" value={counts.ratingsMerged} />
          <Stat label="Notes" value={counts.notesMerged} />
          <Stat label="Days logged" value={counts.watchLogDays} />
          <Stat label="Badges" value={counts.badgesMerged} />
        </dl>

        {statusDifferences.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-body-sm text-fg font-medium">
              These were tracked differently in each place
            </h4>
            <p className="text-meta text-fg-subtle">
              We kept whichever showed more progress. Change any of them back if
              that isn&rsquo;t what you wanted.
            </p>
            <ul className="border-line-subtle divide-line-subtle divide-y rounded-md border">
              {statusDifferences.map((difference) => (
                <li
                  key={difference.key}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2"
                >
                  <Link
                    href={`/title/${difference.mediaType}/${difference.titleId}`}
                    className="text-body-sm text-fg hover:text-accent underline"
                  >
                    {difference.title}
                  </Link>
                  <span className="text-meta text-fg-subtle">
                    {difference.local} / {difference.remote} &rarr;{" "}
                    <span className="text-fg">{difference.result}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {noteConcatenations.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-body-sm text-fg font-medium">
              These notes were written in both places
            </h4>
            <p className="text-meta text-fg-subtle">
              Both versions were kept, one after the other, with a dated marker
              between them. Tidy them up whenever you like.
            </p>
            <ul className="flex flex-wrap gap-2">
              {noteConcatenations.map((note) => (
                <li key={note.key}>
                  <Link
                    href={`/title/${note.mediaType}/${note.titleId}`}
                    className="text-body-sm text-accent hover:underline"
                  >
                    {note.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {scoreDifferences.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-body-sm text-fg font-medium">
              These ratings differed
            </h4>
            <p className="text-meta text-fg-subtle">
              The more recent score was kept. This is the only place the merge
              had to choose between two values.
            </p>
            <ul className="border-line-subtle divide-line-subtle divide-y rounded-md border">
              {scoreDifferences.map((difference) => (
                <li
                  key={difference.key}
                  className="flex items-baseline justify-between gap-3 px-3 py-2"
                >
                  <span className="text-body-sm text-fg">{difference.title}</span>
                  <span className="text-meta text-fg-subtle">
                    {difference.local} / {difference.remote} &rarr;{" "}
                    <span className="text-fg">{difference.result}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-meta text-fg-subtle">
          A backup of this device was saved before the merge started. You can
          download or restore it from{" "}
          <Link href="/account" className="hover:text-fg underline">
            your account settings
          </Link>
          .
        </p>

        {onDismiss && (
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            Got it
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-meta-sm text-fg-subtle uppercase">{label}</dt>
      <dd className="font-display text-display-md text-fg">{value}</dd>
    </div>
  );
}
