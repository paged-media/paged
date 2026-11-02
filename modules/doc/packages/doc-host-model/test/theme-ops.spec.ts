import { describe, expect, it } from "bun:test";

import type { LoweredDoc } from "../src/lowered.js";
import { buildStyleMutations } from "../src/mutations.js";

// Engine ADR 1056: the opened document's theme goes first, and the theme
// swatches carry the slot they follow. A placement brings neither.
function themed(): LoweredDoc {
  return {
    theme: {
      name: "Office Theme",
      colors: [{ slot: "accent1", value: "4472C4" }],
      major: {},
      minor: {},
      source: "<a:theme/>",
    },
    swatches: [
      {
        id: "Color/docx-theme-accent1",
        name: "Accent 1",
        space: "RGB",
        value: [68, 114, 196],
        themeRef: { slot: "accent1" },
      },
      { id: "Color/docx-FF0000", name: "x", space: "RGB", value: [255, 0, 0] },
    ],
    styles: [],
    story: { blocks: [] },
  } as unknown as LoweredDoc;
}

describe("theme ops", () => {
  it("opens with setTheme first and the swatches' themeRef", () => {
    const ops = buildStyleMutations(themed(), { theme: true }) as any[];
    expect(ops[0].op).toBe("setTheme");
    expect(ops[0].args.theme.source).toBe("<a:theme/>");
    expect(ops[1].args.spec.themeRef).toEqual({ slot: "accent1" });
    expect(ops[2].args.spec.themeRef).toBeUndefined();
  });

  it("a placement carries neither the theme nor the references", () => {
    const ops = buildStyleMutations(themed()) as any[];
    expect(ops.some((o) => o.op === "setTheme")).toBe(false);
    expect(ops[0].args.spec.themeRef).toBeUndefined();
  });
});
