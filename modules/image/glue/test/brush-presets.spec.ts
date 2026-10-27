// The brush preset LIBRARY as a pure model: the stock set, every edit
// (refused edits return the same list), Protect Texture, and the own
// "paged-brush-presets" v1 format with its named refusals.

import { describe, expect, it } from "bun:test";

import { DEFAULT_BRUSH_DYNAMICS, cloneDynamics } from "../src/brush-dynamics";
import {
  PresetFormatError,
  addPreset,
  applyPreset,
  defaultPresets,
  deletePreset,
  deserializePresets,
  movePreset,
  nextPresetId,
  renamePreset,
  serializePresets,
  type UserBrushPreset,
} from "../src/brush-presets";

const user = (id: string, name = id): UserBrushPreset => ({
  id,
  name,
  source: "defined",
  params: { size: 20, hardness: 0.5, spacing: 0.25, opacity: 1, flow: 1 },
  dynamics: cloneDynamics(DEFAULT_BRUSH_DYNAMICS),
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PresetFormatError) return [e.code, e.path];
    throw e;
  }
  return null;
};

describe("the stock brushes", () => {
  it("are round brushes with unique ids, an airbrush that builds up and a scattering spray", () => {
    const d = defaultPresets();
    expect(new Set(d.map((p) => p.id)).size).toBe(d.length);
    expect(d.every((p) => p.source === "default")).toBe(true);
    expect(d.map((p) => p.name)).toContain("Hard Round 30");
    const air = d.find((p) => p.id === "default-airbrush-60")!;
    expect(air.dynamics.buildUp).toBe(true);
    expect(air.params.flow).toBe(0.1);
    const spray = d.find((p) => p.id === "default-spray-40")!;
    expect(spray.dynamics.scatter).toMatchObject({
      enabled: true,
      bothAxes: true,
      count: 4,
    });
    // The stock set shares nothing mutable with the defaults.
    expect(DEFAULT_BRUSH_DYNAMICS.scatter.enabled).toBe(false);
  });
});

describe("library edits", () => {
  const list = [user("user-1", "A"), user("user-2", "B"), user("user-3", "C")];

  it("ids are the largest user id plus one", () => {
    expect(nextPresetId([])).toBe("user-1");
    expect(nextPresetId([...list, user("default-x")])).toBe("user-4");
  });

  it("add appends and refuses a duplicate id", () => {
    expect(addPreset(list, user("user-9")).map((p) => p.id)).toEqual([
      "user-1",
      "user-2",
      "user-3",
      "user-9",
    ]);
    expect(addPreset(list, user("user-2"))).toBe(list);
  });

  it("rename trims, keeps the id, and refuses an empty name or an unknown id", () => {
    const out = renamePreset(list, "user-2", "  Chalk  ");
    expect(out[1]).toMatchObject({ id: "user-2", name: "Chalk" });
    expect(list[1].name).toBe("B");
    expect(renamePreset(list, "user-2", "   ")).toBe(list);
    expect(renamePreset(list, "nope", "X")).toBe(list);
    expect(renamePreset(list, "user-2", "B")).toBe(list);
  });

  it("delete removes by id; an unknown id changes nothing", () => {
    expect(deletePreset(list, "user-1").map((p) => p.id)).toEqual([
      "user-2",
      "user-3",
    ]);
    expect(deletePreset(list, "nope")).toBe(list);
  });

  it("move reorders and refuses an index out of range", () => {
    expect(movePreset(list, 0, 2).map((p) => p.name)).toEqual(["B", "C", "A"]);
    expect(movePreset(list, 2, 0).map((p) => p.name)).toEqual(["C", "A", "B"]);
    expect(movePreset(list, 0, 3)).toBe(list);
    expect(movePreset(list, -1, 0)).toBe(list);
    expect(movePreset(list, 1, 1)).toBe(list);
  });
});

describe("applying a preset", () => {
  const textured = (scale: number, protect: boolean) => {
    const p = user(`t${scale}`);
    p.dynamics.texture.enabled = true;
    p.dynamics.texture.scale = scale;
    p.dynamics.protectTexture = protect;
    return p;
  };

  it("takes the preset's parameters and dynamics as copies", () => {
    const p = user("user-1");
    const out = applyPreset(p, DEFAULT_BRUSH_DYNAMICS);
    expect(out.params).toEqual(p.params);
    expect(out.dynamics).toEqual(p.dynamics);
    expect(out.dynamics).not.toBe(p.dynamics);
  });

  it("Protect Texture keeps the current texture when both brushes are textured", () => {
    const current = textured(3, true).dynamics;
    const out = applyPreset(textured(0.5, false), current);
    expect(out.dynamics.texture.scale).toBe(3);
    expect(out.dynamics.protectTexture).toBe(true);
  });

  it("without Protect Texture, or onto an untextured preset, the preset's own texture wins", () => {
    expect(
      applyPreset(textured(0.5, false), textured(3, false).dynamics).dynamics
        .texture.scale,
    ).toBe(0.5);
    const plain = applyPreset(user("u"), textured(3, true).dynamics).dynamics;
    expect(plain.texture.enabled).toBe(false);
  });
});

describe("the own format", () => {
  it("round-trips every field, sampled bitmaps included", () => {
    const p = user("user-1", "Chalk");
    p.dynamics.bitmap = {
      id: "tip-1",
      width: 3,
      height: 2,
      alpha: new Uint8Array([0, 64, 128, 255, 1, 2]),
    };
    p.dynamics.dual.bitmap = {
      id: "tip-2",
      width: 1,
      height: 1,
      alpha: new Uint8Array([200]),
    };
    p.dynamics.shape.angle = {
      jitter: 0.4,
      control: "direction",
      fadeSteps: 12,
      minimum: 0.1,
    };
    p.dynamics.symmetry.kind = "mandala";
    const list = [...defaultPresets(), p];
    const back = deserializePresets(serializePresets(list));
    expect(back).toEqual(list);
    expect(back.at(-1)!.dynamics.bitmap!.alpha).toBeInstanceOf(Uint8Array);
  });

  it("refuses what it does not recognise, by name and path", () => {
    const good = JSON.parse(serializePresets([user("user-1")]));
    const mutate = (f: (d: typeof good) => void) => {
      const d = structuredClone(good);
      f(d);
      return JSON.stringify(d);
    };
    expect(codeOf(() => deserializePresets("{"))).toEqual(["not-json", "$"]);
    expect(codeOf(() => deserializePresets('{"format":"x"}'))).toEqual([
      "wrong-format",
      "$.format",
    ]);
    expect(
      codeOf(() => deserializePresets(mutate((d) => (d.version = 2)))),
    ).toEqual(["unsupported-version", "$.version"]);
    expect(
      codeOf(() => deserializePresets(mutate((d) => (d.presets = {})))),
    ).toEqual(["not-a-list", "$.presets"]);
    expect(
      codeOf(() =>
        deserializePresets(
          mutate((d) => (d.presets[0].dynamics.tip.extra = 1)),
        ),
      ),
    ).toEqual(["unknown-key", "presets[0].dynamics.tip.extra"]);
    expect(
      codeOf(() =>
        deserializePresets(mutate((d) => delete d.presets[0].dynamics.noise)),
      ),
    ).toEqual(["missing-key", "presets[0].dynamics.noise"]);
    expect(
      codeOf(() =>
        deserializePresets(
          mutate((d) => (d.presets[0].dynamics.tip.angle = "30")),
        ),
      ),
    ).toEqual(["wrong-type", "presets[0].dynamics.tip.angle"]);
    expect(
      codeOf(() =>
        deserializePresets(
          mutate(
            (d) => (d.presets[0].dynamics.shape.size.control = "telepathy"),
          ),
        ),
      ),
    ).toEqual(["not-in-list", "presets[0].dynamics.shape.size.control"]);
    expect(
      codeOf(() =>
        deserializePresets(
          mutate(
            (d) =>
              (d.presets[0].dynamics.bitmap = {
                id: "x",
                width: 2,
                height: 2,
                alpha: "AAA=",
              }),
          ),
        ),
      ),
    ).toEqual(["bad-bitmap", "presets[0].dynamics.bitmap"]);
    expect(
      codeOf(() =>
        deserializePresets(
          mutate((d) => d.presets.push(structuredClone(d.presets[0]))),
        ),
      ),
    ).toEqual(["duplicate-id", "presets[1].id"]);
    expect(
      codeOf(() =>
        deserializePresets(mutate((d) => (d.presets[0].source = "magic"))),
      ),
    ).toEqual(["not-in-list", "presets[0].source"]);
  });
});
