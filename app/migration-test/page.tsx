import { Runner } from "./runner";

/** TEMPORARY — Phase 3 Step 1 verification. Delete after review.
 *  No server-side data fetching here on purpose: doing that broke a client
 *  component's hydration outright in an earlier step's harness. */
export default function MigrationTestPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-8">
      <h1 className="font-display text-display-lg uppercase">
        Schema / migration tests
      </h1>
      <Runner />
    </div>
  );
}
