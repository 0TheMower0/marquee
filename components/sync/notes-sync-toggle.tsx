"use client";

import { useEffect, useState } from "react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { getSyncNotes, setSyncNotes } from "@/lib/sync";

/**
 * "Sync private notes" — design doc §7, the one user-facing control in the
 * whole sync design.
 *
 * > Some people genuinely want notes never to leave one device, and honoring
 * > that is one skipped table in the sync loop — near-zero cost for a real
 * > choice. Off means notes stay local; scores still sync.
 *
 * Default ON, because the alternative (a note written on your laptop being
 * invisible on your phone) is a broken feature rather than privacy. The
 * structural protection is that `rating_notes` is its own table with an
 * own-rows-only policy that is never relaxed, so a future sharing feature
 * physically cannot reach it — this toggle is for people who want more than
 * that.
 *
 * A plain checkbox, not a custom switch: it is a binary preference, the native
 * control is keyboard- and screen-reader-correct for free, and `accent-accent`
 * tints it with the page accent the same way the rating slider does.
 */
export function NotesSyncToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSyncNotes().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Null until the stored preference resolves. Rendering an unchecked box
  // first would flash "off" at everyone, which for a privacy control reads as
  // the app having changed the setting.
  if (enabled === null) return null;

  async function toggle(next: boolean) {
    setSaving(true);
    setEnabled(next);
    try {
      await setSyncNotes(next);
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Private notes</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(event) => void toggle(event.target.checked)}
            className="accent-accent mt-0.5 size-4"
          />
          <span>
            <span className="text-body-sm text-fg block">
              Sync my notes to my account
            </span>
            <span className="text-meta text-fg-subtle">
              On by default, so a note written on one device shows up on the
              others. Turn it off and notes stay only on the device you wrote
              them on — your scores still sync either way.
            </span>
          </span>
        </label>

        {!enabled && (
          <p className="text-meta text-fg-subtle">
            Notes already uploaded stay in your account. This stops new ones
            being sent, and stops notes from other devices arriving here.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
