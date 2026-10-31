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
// Engine ADR 1043 — native appearance through the SDK's doors on the real
// engine: the feature flag, the vendored catalog rows, `host.objects`
// reading and writing the layer list, a per-layer write, a refusal, and one
// undo step per write.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

import { propertySchemas } from "../../plugin-api/src/catalog.json";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { HOST_FEATURES } from "../src/host-impl";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function frameOn(h: HeadlessHost): Promise<ElementId> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [20, 20, 120, 120] },
  });
  if (!out.applied || !out.createdId) throw new Error("no frame inserted");
  return out.createdId;
}

const kinds = (v: unknown) =>
  ((v as { value?: Array<{ kind: string }> }).value ?? []).map((e) => e.kind);

describe("frameAppearance (engine ADR 1043) [frames-paths.native-appearance]", () => {
  it("is advertised, and the vendored catalog carries the two rows", () => {
    expect(HOST_FEATURES).toContain("document.appearance@1");
    const rows = (
      propertySchemas as ReadonlyArray<{
        path: string;
        wire?: string;
        type: { kind: string };
      }>
    ).filter((r) => r.path.startsWith("frameAppearance"));
    expect(rows.map((r) => [r.path, r.wire, r.type.kind]).sort()).toEqual([
      ["frameAppearance", "appearance", "list"],
      ["frameAppearanceLayer", "appearanceLayer", "operation"],
    ]);
  });

  it("host.objects reads and writes the layers; one undo restores them", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.appearance@1")).toBe(true);
    const id = await frameOn(h);
    const address = `frame:${String(id.id)}`;
    expect(await h.objects.get(address, "frameAppearance")).toEqual({
      kind: "value",
      value: [],
    });
    const out = await h.objects.set(address, "frameAppearance", [
      { kind: "frameFill" },
      {
        kind: "fill",
        color: "Color/Black",
        opacityPct: 50,
        blendMode: "Multiply",
      },
      { kind: "stroke", color: "Color/Black", weight: 6 },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(kinds(await h.objects.get(address, "frameAppearance"))).toEqual([
      "frameFill",
      "fill",
      "stroke",
    ]);
    await h.host.document.undo();
    expect(await h.objects.get(address, "frameAppearance")).toEqual({
      kind: "value",
      value: [],
    });
  });

  it("frameAppearanceLayer edits one layer; a duplicate placeholder is refused", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const layer = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameAppearanceLayer",
        value: {
          type: "appearanceLayer",
          value: {
            index: 0,
            layer: { kind: "stroke", color: "Color/Black", weight: 3 },
          },
        },
      },
    });
    expect(layer.applied).toBe(true);
    const refused = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameAppearance",
        value: {
          type: "appearance",
          value: { layers: [{ kind: "frameFill" }, { kind: "frameFill" }] },
        },
      },
    });
    expect(refused.applied).toBe(false);
  });
});
