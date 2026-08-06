"use client";

import { Button } from "@/components/ui/button";
import { useSync } from "@/lib/sync";

/**
 * The one dialog in the whole sync design — design doc §6.6.
 *
 * ============================================================================
 * IT IS NOT ASKING ABOUT CONFLICTS. IT IS ASKING ABOUT THE ACCOUNT.
 * ============================================================================
 * The merge is safe: additive-only, backed up first, idempotent. Conflicts are
 * resolved by rules that cannot lose data. So this prompt is not there to let
 * the user arbitrate a merge.
 *
 * It exists for the single irreversible failure in this design: signing into
 * the WRONG account on your own device, where an automatic merge would upload
 * your personal library into someone else's. The local backup does not help —
 * it protects your data, it cannot un-upload it from somewhere else.
 *
 * That is why the copy leads with the two counts. "This device has 214 tracked
 * titles; the account you're signing into has 38" is the sentence that makes
 * someone realise they are in the wrong place, in a way "merge your data?"
 * never would.
 *
 * And why it appears ONLY when both sides are non-empty: the other two cases
 * (new account, or empty device) cannot go wrong, and a dialog there would be
 * friction placed exactly where there is no risk.
 */
export function MergePrompt() {
  const sync = useSync();
  if (!sync?.pendingMerge) return null;

  const { localCounts, remoteCounts } = sync.pendingMerge;

  return (
    <div className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="merge-prompt-title"
        aria-describedby="merge-prompt-body"
        className="bg-surface border-line max-h-full w-full max-w-lg overflow-y-auto rounded-lg border p-6"
      >
        <h2
          id="merge-prompt-title"
          className="font-display text-display-md text-fg uppercase"
        >
          Merge this device with your account?
        </h2>

        <div id="merge-prompt-body" className="text-body-sm text-fg-muted mt-4 space-y-4">
          <p>
            Both this device and the account you just signed into already have
            data. Check that this is the right account before continuing.
          </p>

          <dl className="border-line-subtle grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border p-3">
            <dt className="text-meta text-fg-subtle col-span-1">On this device</dt>
            <dt className="text-meta text-fg-subtle col-span-1">In this account</dt>
            <dd className="text-body text-fg col-span-1">
              {localCounts.titles} titles
              <span className="text-fg-subtle block text-meta">
                {localCounts.ratings} ratings · {localCounts.days} days logged
              </span>
            </dd>
            <dd className="text-body text-fg col-span-1">
              {remoteCounts.titles} titles
              <span className="text-fg-subtle block text-meta">
                {remoteCounts.ratings} ratings · {remoteCounts.days} days logged
              </span>
            </dd>
          </dl>

          <p>
            Merging combines them. Nothing is deleted from either side, and a
            backup of this device is saved first — but uploading your library
            into the wrong account is not something a backup can undo.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {/* autoFocus lands on the SAFE action. Someone dismissing a dialog
              by reflex should hit "not now"; merging has to be deliberate. */}
          <Button autoFocus variant="secondary" onClick={sync.cancelMerge}>
            Not now
          </Button>
          <Button onClick={() => void sync.confirmMerge()}>Merge them</Button>
        </div>
      </div>
    </div>
  );
}
