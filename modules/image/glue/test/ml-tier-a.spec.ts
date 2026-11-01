/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// WP8.2 Tier A (image ADR 485): Select Subject, Select Sky, Object
// Selection and the matting hook, over the REAL image wasm and a scripted
// provider on the shared ML registry. No model runs; nothing downloads.

import { describe, expect, it } from "bun:test";

import { createMlRegistry, fakeMlProvider } from "@paged-media/plugin-sdk";
import { covers, gestures } from "@paged-media/test-kit";

import { blendMatte, skyPoints } from "../src/ml-features";
import { bundleOnFake, C } from "./command-kit";
import { scripted } from "./ml-kit";

async function ingested(withModel = true) {
  const ml = createMlRegistry();
  const s = scripted();
  if (withModel) ml.register(s.provider);
  const k = await bundleOnFake({ ml });
  await k.ingest();
  return { k, ml, ...s };
}
const sel = (k: Awaited<ReturnType<typeof ingested>>["k"]) => {
  const v = k.session.state().selection;
  return v && [v.x, v.y, v.w, v.h];
};

describe("[image.ml.select-subject] Select Subject and Select Sky", () => {
  it("Select Subject turns the model's mask into the selection, one undo step", async () => {
    covers("command:media.paged.image.command.selectSubject");
    const { k, seen } = await ingested();
    const before = k.session.state().history?.depth ?? 0;
    await k.run(`${C}.selectSubject`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().status).toMatch(/scripted\.a/);
    expect(k.session.state().history?.depth).toBe(before + 1);
    expect((seen[0] as { request: object }).request).not.toHaveProperty(
      "points",
    );
    await k.session.undo();
    expect(k.session.state().selection).toBeNull();
    k.dispose();
  });

  it("Select Sky prompts along the top edge", async () => {
    covers("command:media.paged.image.command.selectSky");
    const { k, seen } = await ingested();
    await k.run(`${C}.selectSky`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    const req = (
      seen[0] as { request: { points: Array<{ y: number; label: number }> } }
    ).request;
    expect(req.points).toHaveLength(7);
    expect(req.points.every((p) => p.label === 1 && p.y === 0)).toBe(true);
    k.dispose();
  });

  it("refuses with the registry's message and leaves the image alone", async () => {
    const { k } = await ingested(false);
    await k.run(`${C}.selectSubject`);
    expect(k.session.state().selection).toBeNull();
    expect(k.session.state().status).toMatch(/Select Subject failed/);
    expect(k.session.state().status).toMatch(/model/);
    k.dispose();
  });

  it("an unhealthy provider is a refusal, a recovered one answers (looked up live)", async () => {
    const ml = createMlRegistry();
    const fake = fakeMlProvider({ healthy: false });
    fake.attach(ml.register(fake));
    const k = await bundleOnFake({ ml });
    await k.ingest();
    await k.run(`${C}.selectSubject`);
    expect(k.session.state().status).toMatch(/failed/);
    fake.setHealthy(true);
    await k.run(`${C}.selectSubject`);
    // The fake's brightness mask is empty on the dark test image: it
    // answered (one call), and the empty answer is reported, not applied.
    expect(fake.calls.map((c) => c.capability)).toEqual(["segment"]);
    expect(k.session.state().status).toMatch(/nothing to select/);
    k.dispose();
  });

  it("pure helpers: sky points and the trimap blend", () => {
    const p = skyPoints(100, 50);
    expect(p).toHaveLength(7);
    expect(p[0]!.x).toBeLessThan(p[6]!.x);
    expect(
      Array.from(
        blendMatte(Uint8Array.of(9, 9, 9), Uint8Array.of(0, 128, 255)),
      ),
    ).toEqual([0, 9, 255]);
  });
});

describe("[image.ml.object-selection] the Object Selection tool", () => {
  it("a box drag sends the box, a click sends a point; shift adds", async () => {
    covers("tool:media.paged.image.tool.objectSelection");
    const { k, seen } = await ingested();
    const T = "media.paged.image.tool.objectSelection";
    await gestures(k.toolTarget)
      .tool(T)
      .settle()
      .drag({ from: [25, 25], to: [175, 75], steps: 2 })
      .settle();
    await new Promise((r) => setTimeout(r, 20));
    const first = (seen[0] as { request: { box: { width: number } } }).request;
    expect(first.box.width).toBeGreaterThan(1);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    await gestures(k.toolTarget)
      .tool(T)
      .settle()
      .click([175, 75], { mods: ["shift"] })
      .settle();
    await new Promise((r) => setTimeout(r, 20));
    const second = (seen[1] as { request: { points: Array<{ x: number }> } })
      .request;
    expect(second.points[0]!.x).toBe(3);
    k.dispose();
  });
});

describe("[image.ml.matting] the hair-matting hook of Select and Mask", () => {
  it("asks the matting door, keeps the trimap's known regions", async () => {
    const { k, seen } = await ingested();
    k.session.selectionMachine()!.begin("rect", [0, 0], "replace");
    k.session.selectionMachine()!.update([2, 2]);
    k.session.selectionMachine()!.end();
    k.session.refreshSelection();
    await k.session.masking().openRefine();
    expect(
      seen.some((s) => (s as { capability: string }).capability === "matting"),
    ).toBe(true);
    const alpha = Array.from(k.session.masking().state().refine!.alpha!);
    expect(alpha).toHaveLength(8);
    k.dispose();
  });

  it("without a model the classical solve stays in charge", async () => {
    const { k, seen } = await ingested(false);
    k.session.selectionMachine()!.begin("rect", [0, 0], "replace");
    k.session.selectionMachine()!.update([2, 2]);
    k.session.selectionMachine()!.end();
    k.session.refreshSelection();
    await k.session.masking().openRefine();
    expect(seen.length).toBe(0);
    expect(k.session.masking().state().refine!.alpha).not.toBeNull();
    k.dispose();
  });
});

describe("[image.ml.remove] the Remove tool's provider is looked up live", () => {
  it("a provider that appears after the bundle loaded is used", async () => {
    const ml = createMlRegistry();
    const k = await bundleOnFake({ ml });
    await k.ingest();
    expect(k.session.state().retouch.inpaintProvider).toBeNull();
    const fake = fakeMlProvider({ capabilities: ["inpaint"] });
    fake.attach(ml.register(fake));
    await k.session.removeStroke([1, 1, 2, 1], 2);
    expect(k.session.state().retouch.inpaintProvider).toBe("ml.inpaint");
    expect(fake.calls.some((c) => c.capability === "inpaint")).toBe(true);
    k.dispose();
  });
});
