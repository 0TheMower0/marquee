import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_CONFIG,
  isHomeConfig,
  moveSection,
  toggleSection,
  type HomeConfig,
  type HomeSectionConfig,
} from "./types";

function config(overrides: Partial<HomeConfig> = {}): HomeConfig {
  return { ...DEFAULT_HOME_CONFIG, updatedAt: new Date("2026-08-01T00:00:00Z"), ...overrides };
}

describe("isHomeConfig", () => {
  it("accepts the default config", () => {
    expect(isHomeConfig(DEFAULT_HOME_CONFIG)).toBe(true);
  });

  it("accepts a config with sections reordered", () => {
    expect(
      isHomeConfig(
        config({
          sections: [
            { id: "trending", visible: true },
            { id: "upNext", visible: false },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isHomeConfig(null)).toBe(false);
    expect(isHomeConfig("home")).toBe(false);
    expect(isHomeConfig(42)).toBe(false);
  });

  it("rejects an unknown firstPage", () => {
    expect(isHomeConfig(config({ firstPage: "profile" as never }))).toBe(false);
  });

  it("rejects a missing updatedAt", () => {
    const withoutUpdatedAt: Record<string, unknown> = { ...config() };
    delete withoutUpdatedAt.updatedAt;
    expect(isHomeConfig(withoutUpdatedAt)).toBe(false);
  });

  it("rejects an invalid Date", () => {
    expect(isHomeConfig(config({ updatedAt: new Date("not a date") }))).toBe(false);
  });

  it("rejects a sections list missing a known id — never silently drops a section", () => {
    expect(
      isHomeConfig(config({ sections: [{ id: "upNext", visible: true }] })),
    ).toBe(false);
  });

  it("rejects a sections list with a foreign id", () => {
    expect(
      isHomeConfig(
        config({
          sections: [
            { id: "upNext", visible: true },
            { id: "recommendations", visible: true } as unknown as HomeSectionConfig,
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a duplicated section id, even if the count matches", () => {
    expect(
      isHomeConfig(
        config({
          sections: [
            { id: "upNext", visible: true },
            { id: "upNext", visible: false },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a section missing `visible`", () => {
    expect(
      isHomeConfig(
        config({
          sections: [
            { id: "upNext" } as unknown as HomeSectionConfig,
            { id: "trending", visible: true },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("moveSection", () => {
  const sections: HomeSectionConfig[] = [
    { id: "upNext", visible: true },
    { id: "trending", visible: true },
  ];

  it("moves a section up", () => {
    const moved = moveSection(sections, "trending", "up");
    expect(moved.map((s) => s.id)).toEqual(["trending", "upNext"]);
  });

  it("moves a section down", () => {
    const moved = moveSection(sections, "upNext", "down");
    expect(moved.map((s) => s.id)).toEqual(["trending", "upNext"]);
  });

  it("clamps at the top — moving the first section up is a no-op", () => {
    const moved = moveSection(sections, "upNext", "up");
    expect(moved.map((s) => s.id)).toEqual(["upNext", "trending"]);
  });

  it("clamps at the bottom — moving the last section down is a no-op", () => {
    const moved = moveSection(sections, "trending", "down");
    expect(moved.map((s) => s.id)).toEqual(["upNext", "trending"]);
  });

  it("preserves visibility while reordering", () => {
    const withHidden: HomeSectionConfig[] = [
      { id: "upNext", visible: false },
      { id: "trending", visible: true },
    ];
    const moved = moveSection(withHidden, "trending", "up");
    expect(moved).toEqual([
      { id: "trending", visible: true },
      { id: "upNext", visible: false },
    ]);
  });

  it("does not mutate its input", () => {
    const before = sections.map((s) => ({ ...s }));
    moveSection(sections, "trending", "up");
    expect(sections).toEqual(before);
  });

  it("returns an unchanged copy for an unknown id", () => {
    expect(moveSection(sections, "unknown" as never, "up")).toEqual(sections);
  });
});

describe("toggleSection", () => {
  const sections: HomeSectionConfig[] = [
    { id: "upNext", visible: true },
    { id: "trending", visible: true },
  ];

  it("flips visibility for the named section only", () => {
    const toggled = toggleSection(sections, "upNext");
    expect(toggled).toEqual([
      { id: "upNext", visible: false },
      { id: "trending", visible: true },
    ]);
  });

  it("re-enabling reuses the section's existing position rather than moving it to the end", () => {
    const hidden: HomeSectionConfig[] = [
      { id: "trending", visible: true },
      { id: "upNext", visible: false },
    ];
    const toggled = toggleSection(hidden, "upNext");
    expect(toggled.map((s) => s.id)).toEqual(["trending", "upNext"]);
    expect(toggled[1].visible).toBe(true);
  });

  it("does not mutate its input", () => {
    const before = sections.map((s) => ({ ...s }));
    toggleSection(sections, "upNext");
    expect(sections).toEqual(before);
  });
});

describe("the zero-config guarantee", () => {
  it("DEFAULT_HOME_CONFIG matches Home's pre-existing layout exactly", () => {
    // The whole point of this feature: a user who never opens settings must
    // see NO change at all. Up Next before Trending, both visible, streak
    // badge shown, app opens to Home.
    expect(DEFAULT_HOME_CONFIG.firstPage).toBe("home");
    expect(DEFAULT_HOME_CONFIG.sections.map((s) => s.id)).toEqual(["upNext", "trending"]);
    expect(DEFAULT_HOME_CONFIG.sections.every((s) => s.visible)).toBe(true);
    expect(DEFAULT_HOME_CONFIG.showStreakBadge).toBe(true);
  });

  it("the default's updatedAt always loses a merge comparison against a real edit", () => {
    // The epoch, not "now" — an untouched config must never look freshly
    // edited. See the doc comment on HomeConfig.updatedAt.
    expect(DEFAULT_HOME_CONFIG.updatedAt.getTime()).toBe(0);
  });
});
