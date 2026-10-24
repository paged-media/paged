// paged.image's BRUSH commands (WP5.7) against the REAL canvas engine —
// the integration twin of brush-engine.spec.ts. Brush settings, presets
// and their files are the plugin's state: none of these commands may send
// the document anything, and the CPU-side doors (Define Brush Preset)
// produce the same tip over the real engine as over the fake editor.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C, imageShape } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

/** No document change after the ingest. */
const sentNothing = (k: K) => expect(k.changes()).toBe(0);

describe("brush commands (plugin state, never the document)", () => {
  it("openBrushSettings / openBrushPresets change neither the image nor the document", async () => {
    covers("command:media.paged.image.command.openBrushSettings");
    covers("command:media.paged.image.command.openBrushPresets");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.openBrushSettings`);
    await k.run(`${C}.openBrushPresets`);
    expect(imageShape(k.session)).toEqual(before);
    sentNothing(k);
    k.dispose();
  });

  it("defineBrushPreset makes a 4×2 sampled tip from the real engine's pixels and sends nothing", async () => {
    covers("command:media.paged.image.command.defineBrushPreset");
    const k = await ingested();
    await k.run(`${C}.defineBrushPreset`);
    const p = k.session.state().brushPresets.at(-1)!;
    expect(p.source).toBe("defined");
    expect([p.dynamics.bitmap?.width, p.dynamics.bitmap?.height]).toEqual([
      4, 2,
    ]);
    expect(k.session.state().history?.depth).toBe(0);
    sentNothing(k);
    k.dispose();
  });

  it("importBrushPresets: the headless host wires no picker, and the command says so", async () => {
    covers("command:media.paged.image.command.importBrushPresets");
    const k = await ingested();
    expect(k.h.host.supports("shell.pickFile@1")).toBe(false);
    const n = k.session.state().brushPresets.length;
    await k.run(`${C}.importBrushPresets`);
    expect(k.session.state().status).toMatch(/wires no file picker/);
    expect(k.session.state().brushPresets.length).toBe(n);
    sentNothing(k);
    k.dispose();
  });

  it("exportBrushPresetsAbr / exportBrushPresetsJson: without a saver they say so and send nothing", async () => {
    covers("command:media.paged.image.command.exportBrushPresetsAbr");
    covers("command:media.paged.image.command.exportBrushPresetsJson");
    const k = await ingested();
    const saver = k.h.host.supports("shell.saveFile@1");
    await k.run(`${C}.exportBrushPresetsJson`);
    if (!saver) expect(k.session.state().status).toMatch(/wires no file saver/);
    await k.run(`${C}.exportBrushPresetsAbr`);
    if (!saver) expect(k.session.state().status).toMatch(/wires no file saver/);
    sentNothing(k);
    k.dispose();
  });

  it("toggleLockTransparent flips the lock and sends nothing", async () => {
    covers("command:media.paged.image.command.toggleLockTransparent");
    const k = await ingested();
    await k.run(`${C}.toggleLockTransparent`);
    expect(k.session.state().dynamics.lockAlpha).toBe(true);
    sentNothing(k);
    k.dispose();
  });
});
