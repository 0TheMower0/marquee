"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import {
  backupFilename,
  deleteBackup,
  listBackups,
  restoreSnapshot,
  snapshotToJson,
  type BackupRecord,
} from "@/lib/sync";

/**
 * Pre-merge backups: list, download, restore, delete.
 *
 * ============================================================================
 * THE COPY HERE IS PART OF THE FEATURE
 * ============================================================================
 * The brief asks to "be able to undo a bad merge", and `restoreSnapshot` is
 * honest about what it can and cannot do: it puts back every record the
 * snapshot holds, and it deliberately does NOT delete records created since.
 * Deleting them would make "undo" capable of destroying everything tracked in
 * the meantime — a worse failure than the one being fixed.
 *
 * For the case that matters — resurrected statuses, concatenated notes — the
 * undo is complete, because those are overwrites of records the snapshot has.
 * So the button says "restore", the text says what survives, and neither
 * promises a clean rollback.
 *
 * Backups are never garbage-collected (§6.1). Deleting one is an explicit
 * action here, with a confirm step, because the moment someone finally notices
 * their library looks wrong is usually not the day the merge ran.
 */
export function BackupPanel() {
  const [backups, setBackups] = useState<Array<{ key: string; record: BackupRecord }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listBackups().then((found) => {
      if (!cancelled) setBackups(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (backups.length === 0) return null;

  function download(key: string, record: BackupRecord) {
    // A Blob + object URL rather than a data: URI — a large library serializes
    // to megabytes, and data: URIs hit length limits in some browsers.
    const blob = new Blob([snapshotToJson(record)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = backupFilename(record.takenAt);
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage(`Downloaded ${backupFilename(record.takenAt)}.`);
  }

  async function restore(key: string, record: BackupRecord) {
    setBusy(key);
    setMessage(null);
    try {
      await restoreSnapshot(record.snapshot);
      setMessage(
        "Restored. Reload the page to see it — anything tracked since the backup was kept.",
      );
    } catch {
      setMessage("Couldn't restore that backup. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(key: string) {
    setBusy(key);
    try {
      await deleteBackup(key);
      setBackups(await listBackups());
      setConfirmingDelete(null);
      setMessage("Backup deleted.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Pre-merge backups</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p>
          A snapshot of this device is saved automatically before any merge.
          Download one to keep it somewhere safe — a downloaded file survives
          clearing site data, which a backup stored in the browser does not.
        </p>

        {message && (
          <p role="status" className="text-body-sm text-accent">
            {message}
          </p>
        )}

        <ul className="border-line-subtle divide-line-subtle divide-y rounded-md border">
          {backups.map(({ key, record }) => (
            <li key={key} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-body-sm text-fg">
                  {record.takenAt.toLocaleString()}
                </span>
                <span className="text-meta text-fg-subtle">
                  {Object.keys(record.snapshot.tracking).length} titles ·{" "}
                  {Object.keys(record.snapshot.watchLog).length} days
                </span>
              </div>

              {confirmingDelete === key ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-meta text-danger">
                    Delete this backup permanently?
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    isLoading={busy === key}
                    onClick={() => void remove(key)}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingDelete(null)}
                  >
                    Keep it
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => download(key, record)}>
                    Download
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    isLoading={busy === key}
                    onClick={() => void restore(key, record)}
                  >
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(key)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <p className="text-meta text-fg-subtle">
          Restoring puts back everything the snapshot contains. It does not
          remove anything you have tracked since — undoing a merge should never
          be able to destroy newer work.
        </p>
      </CardBody>
    </Card>
  );
}
