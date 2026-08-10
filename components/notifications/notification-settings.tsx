"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BellIcon } from "@/components/ui/icons";
import { savePrefsAction, syncTimeZoneAction, unfollowShowAction } from "@/lib/notifications/actions";
import { detectTimeZone, formatMinuteOfDay, parseMinuteOfDay } from "@/lib/notifications/quiet-hours";
import type { NotificationSettings as Settings } from "@/lib/notifications/types";

import { PushSetupCard } from "./push-setup-card";

/**
 * The `/notifications` management surface: which device, which shows, when.
 *
 * Takes its initial state as a prop from the server rather than fetching —
 * the page already read it to decide whether to render this at all, and a
 * second round trip would only add a loading state to data already in hand.
 */
export function NotificationSettings({ initial }: { initial: Settings }) {
  const [prefs, setPrefs] = useState(initial.prefs);
  const [follows, setFollows] = useState(initial.follows);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncedZone = useRef(false);

  useEffect(() => {
    // Push the browser's ACTUAL zone up whenever it differs from what is
    // stored — this is what makes quiet hours follow someone who travels,
    // rather than waking them on their old offset. Deliberately narrow: it
    // writes only the timezone, never the rest of prefs, so a background
    // action can't rewrite quiet hours from stale client state.
    if (syncedZone.current) return;
    syncedZone.current = true;

    const current = detectTimeZone();
    if (current === prefs.timeZone) return;

    void syncTimeZoneAction(current).then((result) => {
      if (result.ok) setPrefs((previous) => ({ ...previous, timeZone: current }));
    });
  }, [prefs.timeZone]);

  async function save(next: typeof prefs) {
    setPrefs(next);
    setSaving(true);
    setError(null);
    const result = await savePrefsAction(next);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } else {
      setError(result.message);
    }
  }

  async function removeFollow(showId: string) {
    const previous = follows;
    setFollows((current) => current.filter((follow) => follow.showId !== showId));
    const result = await unfollowShowAction(showId);
    if (!result.ok) {
      setFollows(previous);
      setError(result.message);
    }
  }

  const quietDisabled = prefs.quietStart === prefs.quietEnd;

  return (
    <div className="space-y-10">
      <section aria-labelledby="devices-heading" className="space-y-3">
        <h2 id="devices-heading" className="font-display text-display-md text-fg uppercase">
          This device
        </h2>
        <PushSetupCard />

        {initial.deviceCount === 0 && (
          // Enabled-but-unreachable is otherwise invisible: follows and quiet
          // hours would all look correct while nothing could ever arrive.
          <p className="text-meta text-fg-subtle">
            No devices are set up to receive notifications yet.
          </p>
        )}
      </section>

      <section aria-labelledby="what-heading" className="space-y-3">
        <h2 id="what-heading" className="font-display text-display-md text-fg uppercase">
          What to send
        </h2>
        <p className="text-meta text-fg-muted max-w-prose">
          Marquee only tells you when something changes in the world &mdash; a new
          episode airs, or a new season is announced. It will never send you a
          reminder about what you haven&rsquo;t watched.
        </p>

        <Checkbox
          label="New episode aired"
          checked={prefs.episodeAired}
          onChange={(checked) => void save({ ...prefs, episodeAired: checked })}
        />
        <Checkbox
          label="New season announced"
          checked={prefs.seasonAnnounced}
          onChange={(checked) => void save({ ...prefs, seasonAnnounced: checked })}
        />
      </section>

      <section aria-labelledby="quiet-heading" className="space-y-3">
        <h2 id="quiet-heading" className="font-display text-display-md text-fg uppercase">
          Quiet hours
        </h2>
        <p className="text-meta text-fg-muted max-w-prose">
          Nothing will be sent during these hours. Anything that comes up waits
          until the window closes rather than being dropped.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <TimeField
            label="From"
            value={prefs.quietStart}
            onChange={(minute) => void save({ ...prefs, quietStart: minute })}
          />
          <TimeField
            label="Until"
            value={prefs.quietEnd}
            onChange={(minute) => void save({ ...prefs, quietEnd: minute })}
          />
        </div>

        <p className="text-meta-sm text-fg-subtle">
          {quietDisabled
            ? "Quiet hours are off — set different times to enable them."
            : `Using your device's timezone (${prefs.timeZone}). This follows you if you travel.`}
        </p>
      </section>

      <section aria-labelledby="shows-heading" className="space-y-3">
        <h2 id="shows-heading" className="font-display text-display-md text-fg uppercase">
          Shows you follow
        </h2>

        {follows.length === 0 ? (
          <p className="text-body-sm text-fg-muted max-w-prose">
            You aren&rsquo;t following any shows yet. Open a show&rsquo;s page and
            use <strong>Notify me</strong> to add it &mdash; one at a time, so this
            stays useful instead of noisy.
          </p>
        ) : (
          <ul className="divide-line-subtle border-line-subtle divide-y rounded-md border">
            {follows.map((follow) => (
              <li key={follow.showId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <a
                  href={`/title/tv/${follow.showId}`}
                  className="text-body-sm text-fg flex items-center gap-2 hover:underline"
                >
                  <BellIcon className="text-accent size-4 shrink-0" />
                  {follow.showId}
                </a>
                <Button size="sm" variant="ghost" onClick={() => void removeFollow(follow.showId)}>
                  Stop
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div aria-live="polite" className="text-meta">
        {saving && <span className="text-fg-subtle">Saving&hellip;</span>}
        {saved && !saving && <span className="text-accent">Saved</span>}
        {error && (
          <span role="alert" className="text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="text-body-sm text-fg flex items-center gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-accent size-4"
      />
      {label}
    </label>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (minute: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-meta-sm text-fg-subtle uppercase">{label}</span>
      <input
        type="time"
        value={formatMinuteOfDay(value)}
        onChange={(event) => {
          // Rejected rather than coerced: a silently-wrong quiet window is
          // worse than an edit that visibly doesn't take.
          const minute = parseMinuteOfDay(event.target.value);
          if (minute !== null) onChange(minute);
        }}
        className="bg-surface border-line text-body-sm text-fg rounded-sm border px-2 py-1"
      />
    </label>
  );
}
