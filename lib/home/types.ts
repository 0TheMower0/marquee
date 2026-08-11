/**
 * Home customization — Phase 8 Step 2.
 *
 * Everything a signed-out, never-touched-settings user experiences must be
 * IDENTICAL to Home before this feature existed: Up Next then Trending, both
 * visible, streak badge shown, app opens to Home. `DEFAULT_HOME_CONFIG`
 * below is that state, and every reader in this app falls back to it —
 * there is no code path where "no config yet" renders differently from
 * "config explicitly set to the default".
 */

/**
 * The namespace/key `lib/home/store.ts` writes to, exported (rather than
 * left as a private literal there) so the cold-load first-page redirect
 * script (`redirect-script.ts`, built at Server render time in
 * app/layout.tsx) can compute the exact same localStorage key without a
 * second hardcoded copy that could silently drift from a rename.
 */
export const HOME_CONFIG_NAMESPACE = "home-config";
export const HOME_CONFIG_KEY = "config";

/** The four routes worth opening to. Deliberately NOT Profile — a "first
 *  page" is where you land to DO something (watch, find, track), not the
 *  account/stats surface. */
export type FirstPage = "home" | "library" | "schedule" | "search";

export const FIRST_PAGE_PATH: Record<FirstPage, string> = {
  home: "/",
  library: "/library",
  schedule: "/schedule",
  search: "/search",
};

/**
 * The two real stacked blocks Home renders. The streak badge is deliberately
 * NOT a third entry here — see `showStreakBadge` below for why it is a
 * separate boolean rather than a third orderable section.
 */
export type HomeSectionId = "upNext" | "trending";

export interface HomeSectionConfig {
  id: HomeSectionId;
  visible: boolean;
}

export interface HomeConfig {
  firstPage: FirstPage;
  /** Order IS array order — the section at index 0 renders first. Toggling
   *  visibility never removes an entry, only flips `visible`, so a
   *  re-enabled section reappears in whatever position it was last in
   *  rather than jumping to the end. */
  sections: HomeSectionConfig[];
  /**
   * Whether the small streak pill in Home's header shows at all.
   *
   * Not part of `sections`: that list is stacked, full-width blocks with a
   * meaningful vertical order, and the streak badge is inline header chrome
   * with nowhere sensible to sit "between" two such blocks. Modelling it as
   * a third orderable section would let someone drag it into a position
   * that means nothing, for a control whose only real state is on/off.
   */
  showStreakBadge: boolean;
  /**
   * When this record was last EDITED, not when it was last written to disk —
   * same distinction `RatingEntry.updatedAt` already draws. This is what
   * `lib/sync`'s wire layer sends as `client_updated_at` and what the
   * first-login merge compares to decide which side is newer. A default
   * config that was never touched carries the zero epoch, deliberately:
   * "never edited" must always lose a merge comparison against a real edit
   * from any point in time, and an epoch of `now()` at read time would make
   * the untouched side look freshly edited.
   */
  updatedAt: Date;
}

export const DEFAULT_HOME_CONFIG: HomeConfig = {
  firstPage: "home",
  sections: [
    { id: "upNext", visible: true },
    { id: "trending", visible: true },
  ],
  showStreakBadge: true,
  updatedAt: new Date(0),
};

const FIRST_PAGES: readonly FirstPage[] = ["home", "library", "schedule", "search"];
const SECTION_IDS: readonly HomeSectionId[] = ["upNext", "trending"];

function isFirstPage(value: unknown): value is FirstPage {
  return typeof value === "string" && (FIRST_PAGES as readonly string[]).includes(value);
}

function isHomeSectionConfig(value: unknown): value is HomeSectionConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (SECTION_IDS as readonly string[]).includes(candidate.id) &&
    typeof candidate.visible === "boolean"
  );
}

/**
 * Structural validation, used both by `lib/storage`'s per-record migration
 * gate (a corrupt or foreign-shaped record degrades to `null`, never a
 * crash) and by `lib/sync`'s wire layer (a `jsonb` column reachable directly
 * through PostgREST is exactly as untrusted as anything else off the wire).
 *
 * DELIBERATELY strict about `sections`: every known id, exactly once, no
 * duplicates and nothing foreign. A partial or reordered-with-a-typo list
 * would be a worse failure than falling back to the default, because it
 * would silently drop a section from the UI with no way for the reader to
 * tell "hidden on purpose" from "the record was malformed".
 */
export function isHomeConfig(value: unknown): value is HomeConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (!isFirstPage(candidate.firstPage)) return false;
  if (typeof candidate.showStreakBadge !== "boolean") return false;
  if (!(candidate.updatedAt instanceof Date) || Number.isNaN(candidate.updatedAt.getTime())) {
    return false;
  }
  if (!Array.isArray(candidate.sections)) return false;
  if (!candidate.sections.every(isHomeSectionConfig)) return false;

  const ids = candidate.sections.map((section) => (section as HomeSectionConfig).id);
  if (ids.length !== SECTION_IDS.length) return false;
  if (new Set(ids).size !== ids.length) return false;
  if (!SECTION_IDS.every((id) => ids.includes(id))) return false;

  return true;
}

/** Moves a section earlier or later in the order, clamped to the array's
 *  bounds. Pure — the caller persists the result. */
export function moveSection(
  sections: readonly HomeSectionConfig[],
  id: HomeSectionId,
  direction: "up" | "down",
): HomeSectionConfig[] {
  const index = sections.findIndex((section) => section.id === id);
  if (index === -1) return [...sections];

  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= sections.length) return [...sections];

  const next = [...sections];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function toggleSection(
  sections: readonly HomeSectionConfig[],
  id: HomeSectionId,
): HomeSectionConfig[] {
  return sections.map((section) =>
    section.id === id ? { ...section, visible: !section.visible } : section,
  );
}
