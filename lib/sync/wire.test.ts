import { describe, expect, it } from "vitest";

import { DEFAULT_HOME_CONFIG, type HomeConfig } from "@/lib/home";

import { homeConfigToRow, rowToHomeConfig } from "./wire";
import type { HomeConfigRow } from "./types";

/**
 * home_config's translation is the only pair in this file with real
 * validation logic (everything else here converts a known-good local shape),
 * so it is the one pair that gets its own dedicated test file rather than
 * indirect coverage through merge.test.ts.
 */

const USER = "11111111-1111-1111-1111-111111111111";

function config(overrides: Partial<HomeConfig> = {}): HomeConfig {
  return { ...DEFAULT_HOME_CONFIG, updatedAt: new Date("2026-08-01T00:00:00Z"), ...overrides };
}

describe("homeConfigToRow", () => {
  it("excludes updatedAt from the jsonb payload — it has its own column", () => {
    const row = homeConfigToRow(USER, config());
    expect(row.config).not.toHaveProperty("updatedAt");
    expect(row.client_updated_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("carries the user id and the rest of the config through untouched", () => {
    const row = homeConfigToRow(
      USER,
      config({ firstPage: "schedule", showStreakBadge: false }),
    );
    expect(row.user_id).toBe(USER);
    expect(row.config).toMatchObject({ firstPage: "schedule", showStreakBadge: false });
  });
});

describe("rowToHomeConfig", () => {
  it("round-trips a valid row", () => {
    const original = config({ firstPage: "library" });
    const row = homeConfigToRow(USER, original);
    expect(rowToHomeConfig(row)).toEqual(original);
  });

  it("returns null for a malformed config rather than throwing", () => {
    // A jsonb column reachable through PostgREST is exactly as untrusted as
    // any other server response.
    const row: HomeConfigRow = {
      user_id: USER,
      config: { firstPage: "not-a-real-page" },
      client_updated_at: "2026-08-01T00:00:00Z",
    };
    expect(rowToHomeConfig(row)).toBeNull();
  });

  it("returns null when config is not an object at all", () => {
    const row: HomeConfigRow = {
      user_id: USER,
      config: "garbage",
      client_updated_at: "2026-08-01T00:00:00Z",
    };
    expect(rowToHomeConfig(row)).toBeNull();
  });

  it("rejects a sections list missing an id — never silently drops a section", () => {
    const row: HomeConfigRow = {
      user_id: USER,
      config: { firstPage: "home", showStreakBadge: true, sections: [{ id: "upNext", visible: true }] },
      client_updated_at: "2026-08-01T00:00:00Z",
    };
    expect(rowToHomeConfig(row)).toBeNull();
  });
});
