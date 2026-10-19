// The `.abr` brush-library lane: the bundle door over the reader, the
// JSON→`BrushParams` projection, and the panel section that makes both
// reachable.
//
// WHY THIS FILE EXISTS AT ALL. `image-psd`'s `.abr` reader is a large,
// spec-cited, corpus-gated parser that had NO caller — so a wasm32
// release build eliminated it wholesale. The capability was in the
// repository and not in the artifact. `abr_presets` is its only caller;
// these specs are what stops it becoming dead code again.
//
// WHAT IS PROVEN WHERE. Parsing bytes → JSON is Rust's half
// (`image-js/src/brushes.rs`, 11 tests, including one that pins the wire
// string BYTE FOR BYTE). This file covers the half that lives in glue:
// the JSON→brush-parameter mapping, what it refuses to apply, and what
// the panel says about it. The wire literal below is the SAME string
// that Rust test asserts — deliberately, so the two halves cannot drift
// in silence.

import { describe, expect, it } from "bun:test";

import { createBundleHost } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import manifestJson from "@paged-media/image-manifest/manifest.json";

import { wrapEngine, type ImageWasmModule } from "../src/engine";
import { createImageSession } from "../src/session";
import { BrushPresetsSection } from "../src/panels/image-panel";
import {
  makeFakeEditor,
  mapBacking,
  shellStub,
  silentConsole,
} from "./helpers";
import { abrBytes } from "./fixtures/abr";

/** The exact wire `render_json` produces for one computed preset. Pinned
 *  identically in `image-js/src/brushes.rs`
 *  (`…the_wire_shape_is_pinned_on_both_sides`) — change one, the other
 *  fails and says so. */
const ONE_PRESET_WIRE =
  '{"version":6,"minorVersion":2,"presetCount":1,"sampleCount":0,' +
  '"warnings":[],"presets":[{"index":0,"name":"Soft Round 30",' +
  '"kind":"computed","diameter":30,"diameterUnit":"#Pxl",' +
  '"hardness":0.5,"spacing":0.25,"spacingEnabled":true,' +
  '"roundness":1,"angle":0}]}';

/** A library whose presets exercise every "cannot apply that" branch. */
const AWKWARD_WIRE = JSON.stringify({
  version: 6,
  minorVersion: 2,
  presetCount: 4,
  sampleCount: 1,
  warnings: ["HierarchyUnbalanced { opens: 2, closes: 1 }"],
  presets: [
    {
      index: 0,
      name: "Bitmap 64",
      kind: "sampled",
      diameter: 64,
      diameterUnit: "#Pxl",
      hardness: null,
      spacing: 0.4,
      spacingEnabled: true,
      roundness: 1,
      angle: 0,
    },
    {
      index: 1,
      name: "Angled ellipse",
      kind: "computed",
      diameter: 40,
      diameterUnit: "#Pxl",
      hardness: 0.9,
      spacing: 0.2,
      spacingEnabled: false,
      roundness: 0.4,
      angle: 45,
    },
    {
      index: 2,
      name: "Percent size",
      kind: "computed",
      diameter: 50,
      diameterUnit: "#Prc",
      hardness: 0.1,
      spacing: 0.3,
      spacingEnabled: true,
      roundness: 1,
      angle: 0,
    },
    {
      index: 3,
      name: "Exotic",
      kind: "unsupported",
      diameter: null,
      diameterUnit: null,
      hardness: null,
      spacing: null,
      spacingEnabled: null,
      roundness: null,
      angle: null,
    },
  ],
});

/** A wasm stub whose only job is to answer `abr_presets`. */
function fakeWasm(answer: string | (() => string)) {
  return {
    abr_presets: () => (typeof answer === "string" ? answer : answer()),
    brush_blend_modes: () => "normal\nmultiply",
  } as unknown as ImageWasmModule;
}

function sessionOn(shell = shellStub()) {
  const fake = makeFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    { console: silentConsole, storage: mapBacking(), shell },
  );
  return { session: createImageSession(handle.host), handle, fake };
}

describe("the engine facade's .abr door", () => {
  it("parses the wire into the shape the panel consumes", () => {
    const engine = wrapEngine(fakeWasm(ONE_PRESET_WIRE));
    const lib = engine.abrPresets(new Uint8Array([1]));
    expect(lib.presetCount).toBe(1);
    expect(lib.presets[0]).toEqual({
      index: 0,
      name: "Soft Round 30",
      kind: "computed",
      diameter: 30,
      diameterUnit: "#Pxl",
      hardness: 0.5,
      spacing: 0.25,
      spacingEnabled: true,
      roundness: 1,
      angle: 0,
    });
  });

  it("lets the reader's own refusal through instead of a generic failure", () => {
    const engine = wrapEngine(
      fakeWasm(() => {
        throw new Error("legacy .abr version 1: a pre-descriptor format");
      }),
    );
    expect(() => engine.abrPresets(new Uint8Array([1]))).toThrow(
      /legacy \.abr version 1/,
    );
  });
});

describe("the panel's Brush presets section", () => {
  const render = (
    over: Partial<Parameters<typeof BrushPresetsSection>[0]> = {},
  ) =>
    textOf(
      BrushPresetsSection({
        library: null,
        libraryName: null,
        activePreset: null,
        disabled: false,
        onLoad: () => {},
        onApply: () => {},
        onClose: () => {},
        ...over,
      }),
    )
      .join(" ")
      .replace(/\s+/g, " ");

  const lib = (wire: string) =>
    JSON.parse(wire) as Parameters<typeof BrushPresetsSection>[0]["library"];

  it("offers the loader and explains what an .abr is before one is loaded", () => {
    const text = render();
    expect(text).toContain("Load .abr…");
    expect(text).toContain("No library loaded");
    // The framing that stops a designer expecting Photoshop's pixels.
    expect(text).toContain("parameters, not pixels");
  });

  it("lists presets with the parameters each one actually carries", () => {
    const text = render({ library: lib(ONE_PRESET_WIRE) });
    expect(text).toContain("Soft Round 30");
    expect(text).toContain("30 px");
    expect(text).toContain("hardness 0.50");
    expect(text).toContain("spacing 0.25");
  });

  it("says on screen what it cannot apply, rather than in a changelog", () => {
    const text = render({ library: lib(AWKWARD_WIRE) });
    expect(text).toContain("Roundness and angle are shown but not applied");
    expect(text).toContain("sampled (bitmap) tip");
    // A preset whose spacing the file DISABLED reads as disabled, not as
    // a number the engine is about to use.
    expect(text).toContain("spacing off");
    // A non-pixel diameter keeps its unit in the readout.
    expect(text).toContain("#Prc");
  });

  it("surfaces the reader's warnings instead of swallowing them", () => {
    const text = render({ library: lib(AWKWARD_WIRE) });
    expect(text).toContain("parsed this file with 1 warning");
    expect(text).toContain("HierarchyUnbalanced");
  });

  it("distinguishes an empty library from a failed read", () => {
    const empty = lib(
      '{"version":6,"minorVersion":2,"presetCount":0,"sampleCount":0,' +
        '"warnings":[],"presets":[]}',
    );
    const text = render({ library: empty, libraryName: "empty.abr" });
    expect(text).toContain("contains no presets");
    expect(text).toContain("not the same as a file that failed to read");
  });
});

// ── the session, over REAL `.abr` bytes and the REAL engine wasm ─────

describe("the brush-library session lane (real reader, real bytes)", () => {
  /** A session over the real wasm. The library door BOOTS the engine on
   *  demand, so nothing has to be ingested first — which is the point:
   *  a designer picks a brush before there is anything to paint on. */
  async function ready(shell: ReturnType<typeof shellStub> = shellStub()) {
    return sessionOn(shell);
  }

  it("loads a library and reports what it holds", async () => {
    const { session, handle } = await ready();
    const ok = await session.loadBrushLibrary(
      "sample.abr",
      abrBytes([
        { name: "Soft Round 30", diameter: 30, hardness: 0.5 },
        { name: "Hard Round 9", diameter: 9, hardness: 1 },
      ]),
    );
    expect(ok).toBe(true);
    const lib = session.state().brushLibrary;
    expect(lib?.presetCount).toBe(2);
    expect(lib?.presets.map((p) => p.name)).toEqual([
      "Soft Round 30",
      "Hard Round 9",
    ]);
    expect(lib?.presets[0].diameter).toBe(30);
    expect(lib?.presets[0].hardness).toBeCloseTo(0.5, 6);
    // Read as a FRACTION of the diameter, from a percent on the wire.
    expect(lib?.presets[0].spacing).toBeCloseTo(0.25, 6);
    expect(session.state().status).toContain("2 brush presets");
    session.dispose();
    handle.dispose();
  });

  it("applies a preset onto the live brush parameters", async () => {
    const { session, handle } = await ready();
    session.setBrushParams({ size: 24, hardness: 0.5, spacing: 0.25 });
    await session.loadBrushLibrary(
      "sample.abr",
      abrBytes([{ name: "Hard Round 9", diameter: 9, hardness: 1 }]),
    );
    expect(session.applyBrushPreset(0)).toBe(true);
    expect(session.state().brush).toMatchObject({
      size: 9,
      hardness: 1,
      spacing: 0.25,
    });
    expect(session.state().brushPreset).toBe(0);
    expect(session.state().status).toContain("Hard Round 9");
    session.dispose();
    handle.dispose();
  });

  it("drops the preset mark the moment a slider moves", async () => {
    // The brush stops BEING the preset once it is edited; a row left
    // highlighted would claim a provenance the next stroke does not have.
    const { session, handle } = await ready();
    await session.loadBrushLibrary(
      "sample.abr",
      abrBytes([{ name: "Hard Round 9", diameter: 9, hardness: 1 }]),
    );
    session.applyBrushPreset(0);
    expect(session.state().brushPreset).toBe(0);
    session.setBrushParams({ size: 40 });
    expect(session.state().brushPreset).toBeNull();
    session.dispose();
    handle.dispose();
  });

  it("refuses non-.abr bytes with the reader's own reason", async () => {
    const { session, handle } = await ready();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(await session.loadBrushLibrary("not-a-brush.png", png)).toBe(false);
    expect(session.state().brushLibrary).toBeNull();
    // The message names the file AND carries the reader's diagnosis —
    // a generic "could not load" would throw the diagnosis away.
    expect(session.state().status).toContain("not-a-brush.png");
    expect(session.state().status.length).toBeGreaterThan(
      "not-a-brush.png: ".length,
    );
    session.dispose();
    handle.dispose();
  });

  it("reads through the host picker, and says when there is none", async () => {
    const bytes = abrBytes([
      { name: "Picked 12", diameter: 12, hardness: 0.25 },
    ]);
    // The stub shell has a pickFile, so the door is SUPPORTED and the
    // picked bytes flow through.
    const withPicker = await ready({
      ...shellStub(),
      pickFile: async () => [{ name: "picked.abr", bytes, mimeType: "" }],
    } as unknown as ReturnType<typeof shellStub>);
    expect(await withPicker.session.pickBrushLibrary()).toBe(true);
    expect(withPicker.session.state().brushLibraryName).toBe("picked.abr");
    expect(withPicker.session.state().brushLibrary?.presets[0].name).toBe(
      "Picked 12",
    );
    withPicker.session.dispose();
    withPicker.handle.dispose();

    // And a cancel is a cancel — not a failed read.
    const cancelled = await ready();
    expect(await cancelled.session.pickBrushLibrary()).toBe(false);
    expect(cancelled.session.state().status).toContain("No brush library");
    expect(cancelled.session.state().brushLibrary).toBeNull();
    cancelled.session.dispose();
    cancelled.handle.dispose();
  });

  it("closing forgets the library without touching the brush", async () => {
    const { session, handle } = await ready();
    await session.loadBrushLibrary(
      "sample.abr",
      abrBytes([{ name: "Hard Round 9", diameter: 9, hardness: 1 }]),
    );
    session.applyBrushPreset(0);
    const brush = { ...session.state().brush };
    session.closeBrushLibrary();
    expect(session.state().brushLibrary).toBeNull();
    expect(session.state().brushLibraryName).toBeNull();
    expect(session.state().brushPreset).toBeNull();
    expect(session.state().brush).toEqual(brush);
    session.dispose();
    handle.dispose();
  });

  it("an out-of-range preset index is refused, not clamped", async () => {
    const { session, handle } = await ready();
    await session.loadBrushLibrary(
      "sample.abr",
      abrBytes([{ name: "Only one", diameter: 20, hardness: 0.5 }]),
    );
    const before = { ...session.state().brush };
    expect(session.applyBrushPreset(7)).toBe(false);
    expect(session.state().brush).toEqual(before);
    session.dispose();
    handle.dispose();
  });
});

/** Render a pure element tree to its text, executing the (hook-free)
 *  function components it contains. No react-dom needed. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean")
    return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === "function") {
    return textOf((el.type as (p: unknown) => unknown)(el.props), out);
  }
  if (el.props) textOf(el.props.children, out);
  return out;
}
