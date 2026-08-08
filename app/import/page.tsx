import type { Metadata } from "next";

import { ImportView } from "@/components/import/import-view";

export const metadata: Metadata = {
  title: "Import",
  description: "Bring your history in from IMDb or Letterboxd.",
};

/**
 * Client-rendered throughout, deliberately: the file is read on this device,
 * the library it writes into lives in this browser's storage, and nothing on
 * this page can be answered by a server render. Keeping the route a thin
 * shell also keeps it STATIC — the same rendering discipline `/library` and
 * `/profile/stats` follow.
 */
export default function ImportPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="font-display text-display-xl text-fg uppercase">Import</h1>
        <p className="text-body-sm text-fg-muted mt-2 max-w-prose">
          Bring your history in from IMDb or Letterboxd. Everything is matched
          and shown to you first — nothing is written to your library until you
          say so.
        </p>
      </header>

      <ImportView />
    </div>
  );
}
