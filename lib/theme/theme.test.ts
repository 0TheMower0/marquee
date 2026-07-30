import { describe, expect, it } from "vitest";

import {
  ACCENT_C_MAX,
  ACCENT_C_MIN,
  ACCENT_L_MAX,
  ACCENT_L_MIN,
  harmonizeAccent,
  harmonizeDim,
  harmonizeHover,
  hueDistance,
  MARQUEE_CYAN,
  MARQUEE_GOLD,
  rotateHue,
  SECONDARY_HUE_ROTATION,
  WCAG_AA_NORMAL,
} from "./harmonize";
import {
  contrastRatio,
  oklchInGamut,
  oklchToRgb,
  parseHex,
  relativeLuminance,
  rgbToOklch,
  toHex,
  type Rgb,
} from "./oklch";

const hex = (value: string) => parseHex(value) as Rgb;

const INK_800 = hex("#0b0b0e"); // --bg-base
const INK_900 = hex("#060608"); // --fg-on-accent

/* ---------------------------------------------------------------------------
 * Colour space
 * ------------------------------------------------------------------------ */

describe("rgbToOklch", () => {
  // Hand-computed through the OKLab matrices; these two anchor the whole band
  // in harmonize.ts, so if they drift the band is no longer fitted to anything.
  it("places marquee gold at oklch(0.795 0.143 83.5)", () => {
    const { L, C, h } = rgbToOklch(hex(MARQUEE_GOLD));
    expect(L).toBeCloseTo(0.7952, 3);
    expect(C).toBeCloseTo(0.1434, 3);
    expect(h).toBeCloseTo(83.54, 1);
  });

  it("places marquee cyan at oklch(0.804 0.127 206.5)", () => {
    const { L, C, h } = rgbToOklch(hex(MARQUEE_CYAN));
    expect(L).toBeCloseTo(0.8045, 3);
    expect(C).toBeCloseTo(0.1274, 3);
    expect(h).toBeCloseTo(206.468, 2);
  });

  it("reports zero chroma for greys", () => {
    for (const grey of ["#000000", "#808080", "#ffffff"]) {
      expect(rgbToOklch(hex(grey)).C).toBeCloseTo(0, 4);
    }
  });

  it("round-trips through oklchToRgb within one 8-bit step", () => {
    for (const value of ["#e8b33c", "#35d6e8", "#f87171", "#4ade80", "#1d1d24"]) {
      const original = hex(value);
      const round = oklchToRgb(rgbToOklch(original));
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(round[i] - original[i])).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("oklchInGamut", () => {
  it("accepts the brand accents", () => {
    expect(oklchInGamut(rgbToOklch(hex(MARQUEE_GOLD)))).toBe(true);
    expect(oklchInGamut(rgbToOklch(hex(MARQUEE_CYAN)))).toBe(true);
  });

  it("rejects a chroma no sRGB display can show", () => {
    expect(oklchInGamut({ L: 0.8, C: 0.4, h: 250 })).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * WCAG
 * ------------------------------------------------------------------------ */

describe("contrastRatio", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio(hex("#000000"), hex("#ffffff"))).toBeCloseTo(21, 5);
  });

  it("returns 1 for a colour against itself", () => {
    expect(contrastRatio(hex("#e8b33c"), hex("#e8b33c"))).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    expect(contrastRatio(hex("#e8b33c"), INK_800)).toBeCloseTo(
      contrastRatio(INK_800, hex("#e8b33c")),
      10,
    );
  });

  it("measures marquee gold on the page background at 10.24:1", () => {
    expect(contrastRatio(hex(MARQUEE_GOLD), INK_800)).toBeCloseTo(10.24, 1);
  });

  it("ranks a mid grey below AA against the page background", () => {
    // Guards the assertion the whole module rests on: being "a colour" is not
    // the same as being a usable accent.
    expect(contrastRatio(hex("#3a3a3a"), INK_800)).toBeLessThan(WCAG_AA_NORMAL);
  });
});

describe("relativeLuminance", () => {
  it("weights green far above blue", () => {
    expect(relativeLuminance(hex("#00ff00"))).toBeGreaterThan(
      relativeLuminance(hex("#0000ff")) * 5,
    );
  });
});

/* ---------------------------------------------------------------------------
 * Harmonize — the contrast guarantee
 * ------------------------------------------------------------------------ */

describe("harmonizeAccent", () => {
  it("returns marquee gold essentially unchanged — it is already in band", () => {
    const result = harmonizeAccent(rgbToOklch(hex(MARQUEE_GOLD)));
    expect(result).not.toBeNull();
    const { L, C } = rgbToOklch(hex(result as string));
    expect(L).toBeGreaterThanOrEqual(ACCENT_L_MIN - 0.01);
    expect(L).toBeLessThanOrEqual(ACCENT_L_MAX + 0.01);
    expect(C).toBeGreaterThanOrEqual(ACCENT_C_MIN - 0.01);
  });

  it("preserves hue — hue is the title's identity", () => {
    for (const h of [0, 45, 83, 150, 206, 270, 330]) {
      const result = harmonizeAccent({ L: 0.3, C: 0.05, h });
      expect(result).not.toBeNull();
      // Gamut clipping can nudge hue slightly; a few degrees is not a hue change.
      expect(hueDistance(rgbToOklch(hex(result as string)).h, h)).toBeLessThan(6);
    }
  });

  it("lifts a too-dark candidate into the band", () => {
    const result = harmonizeAccent({ L: 0.18, C: 0.12, h: 30 });
    expect(result).not.toBeNull();
    expect(rgbToOklch(hex(result as string)).L).toBeGreaterThanOrEqual(ACCENT_L_MIN - 0.01);
  });

  it("pulls a too-light candidate down into the band", () => {
    const result = harmonizeAccent({ L: 0.99, C: 0.1, h: 200 });
    expect(result).not.toBeNull();
    expect(rgbToOklch(hex(result as string)).L).toBeLessThanOrEqual(ACCENT_L_MAX + 0.02);
  });

  it("amplifies a near-grey candidate up to the minimum chroma", () => {
    // The near-monochrome poster case: a faint hue is worth keeping, so it gets
    // boosted rather than discarded. (A TRULY achromatic image never reaches
    // here — extract.ts rejects it on chromatic share.)
    const result = harmonizeAccent({ L: 0.5, C: 0.004, h: 210 });
    expect(result).not.toBeNull();
    expect(rgbToOklch(hex(result as string)).C).toBeGreaterThanOrEqual(ACCENT_C_MIN - 0.01);
  });

  it("caps an over-saturated candidate", () => {
    const result = harmonizeAccent({ L: 0.8, C: 0.35, h: 320 });
    expect(result).not.toBeNull();
    expect(rgbToOklch(hex(result as string)).C).toBeLessThanOrEqual(ACCENT_C_MAX + 0.01);
  });

  // The load-bearing test. Clamping into the band is NOT assumed to imply AA —
  // WCAG luminance is not perceptually uniform, so this sweeps every hue and
  // asserts the measured ratio in both roles the token plays.
  it("meets WCAG AA against BOTH surfaces, at every hue", () => {
    for (let h = 0; h < 360; h += 5) {
      for (const C of [0.0, 0.05, 0.12, 0.2, 0.35]) {
        for (const L of [0.05, 0.3, 0.5, 0.8, 0.99]) {
          const result = harmonizeAccent({ L, C, h });
          expect(result, `no accent for oklch(${L} ${C} ${h})`).not.toBeNull();
          const rgb = hex(result as string);
          expect(
            contrastRatio(rgb, INK_800),
            `${result} vs page background at h=${h} L=${L} C=${C}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
          expect(
            contrastRatio(rgb, INK_900),
            `on-accent text on ${result} at h=${h} L=${L} C=${C}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
        }
      }
    }
  });

  it("is deterministic", () => {
    const input = { L: 0.42, C: 0.09, h: 137 };
    expect(harmonizeAccent(input)).toBe(harmonizeAccent(input));
  });
});

describe("harmonizeHover", () => {
  it("is lighter than the base accent", () => {
    const base = MARQUEE_GOLD;
    const hover = harmonizeHover(base);
    expect(rgbToOklch(hex(hover)).L).toBeGreaterThan(rgbToOklch(hex(base)).L);
  });

  it("still meets AA — hover is used for text as well as fills", () => {
    for (let h = 0; h < 360; h += 15) {
      const accent = harmonizeAccent({ L: 0.78, C: 0.13, h }) as string;
      const hover = hex(harmonizeHover(accent));
      expect(contrastRatio(hover, INK_800)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      expect(contrastRatio(hover, INK_900)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
    }
  });

  it("returns the input unchanged when handed a malformed colour", () => {
    expect(harmonizeHover("not-a-colour")).toBe("not-a-colour");
  });
});

describe("harmonizeDim", () => {
  it("is darker than the base accent", () => {
    expect(rgbToOklch(hex(harmonizeDim(MARQUEE_GOLD))).L).toBeLessThan(
      rgbToOklch(hex(MARQUEE_GOLD)).L,
    );
  });

  it("keeps the accent's hue", () => {
    const dim = harmonizeDim(MARQUEE_CYAN);
    expect(hueDistance(rgbToOklch(hex(dim)).h, rgbToOklch(hex(MARQUEE_CYAN)).h)).toBeLessThan(10);
  });
});

/* ---------------------------------------------------------------------------
 * Hue helpers
 * ------------------------------------------------------------------------ */

describe("rotateHue", () => {
  it("wraps past 360", () => {
    expect(rotateHue({ L: 0.8, C: 0.1, h: 300 }, 150).h).toBeCloseTo(90, 6);
  });

  it("produces a secondary clearly distinct from its primary", () => {
    for (let h = 0; h < 360; h += 10) {
      const rotated = rotateHue({ L: 0.8, C: 0.12, h }, SECONDARY_HUE_ROTATION);
      expect(hueDistance(rotated.h, h)).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("hueDistance", () => {
  it("takes the short way around the circle", () => {
    expect(hueDistance(350, 10)).toBeCloseTo(20, 6);
    expect(hueDistance(10, 350)).toBeCloseTo(20, 6);
    expect(hueDistance(0, 180)).toBeCloseTo(180, 6);
  });
});

/* ---------------------------------------------------------------------------
 * Hex
 * ------------------------------------------------------------------------ */

describe("parseHex", () => {
  it("accepts long and short form", () => {
    expect(parseHex("#e8b33c")).toEqual([232, 179, 60]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("e8b33c")).toEqual([232, 179, 60]);
  });

  it("returns null rather than throwing on junk", () => {
    for (const bad of ["", "#", "#12345", "#gggggg", "rgb(1,2,3)"]) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it("round-trips with toHex", () => {
    expect(toHex(parseHex("#0b0b0e") as Rgb)).toBe("#0b0b0e");
  });
});
