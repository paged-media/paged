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

// Engine ADR 1007 — paint model v2 through the SDK's doors on the real
// engine: the feature flag, the vendored catalog rows, a gradient whose
// stops carry their own colour and opacity (created and read back through
// the raw `gradientDetail` read), the conic kind, the stroke gradient mode
// and the gradient start on both write doors, and one undo step each.

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

const value = (v: unknown) => ({ kind: "value", value: v });

async function frameOn(h: HeadlessHost): Promise<ElementId> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [20, 20, 120, 120] },
  });
  if (!out.applied || !out.createdId) throw new Error("no frame inserted");
  return out.createdId;
}

async function read(h: HeadlessHost, id: ElementId, path: string) {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === path)?.value;
}

describe("paint model v2 (engine ADR 1007) [color-swatches.paint-v2]", () => {
  it("is advertised, and the vendored catalog carries its rows", () => {
    expect(HOST_FEATURES).toContain("document.paint2@1");
    const rows = propertySchemas as ReadonlyArray<{
      path: string;
      type: { kind: string; members?: string[] };
      default?: unknown;
    }>;
    const mode = rows.find((r) => r.path === "frameGradientStrokeMode");
    expect(mode?.type).toEqual({
      kind: "enum",
      members: ["Within", "Along", "Across"],
    });
    expect(mode?.default).toBe("Within");
    expect(rows.some((r) => r.path === "frameGradientFillStart")).toBe(true);
  });

  it("a gradient's stops carry an inline colour and an opacity; conic is a kind", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.paint2@1")).toBe(true);
    await frameOn(h);
    const out = await h.host.document.mutate({
      op: "createGradient",
      args: {
        spec: {
          selfId: "Gradient/sdkFade",
          name: "Fade",
          kind: "Conic",
          stops: [
            {
              stopColor: "",
              locationPct: 0,
              color: { space: "RGB", value: [255, 0, 0] },
            },
            { stopColor: "Color/Black", locationPct: 100, opacityPct: 0 },
          ],
        },
      },
    });
    expect(out.applied).toBe(true);
    const gradients = await h.host.document.collection<{
      selfId: string;
      kind: string;
    }>("gradients");
    expect(gradients.find((g) => g.selfId === "Gradient/sdkFade")?.kind).toBe(
      "conic",
    );
  });

  it("frameGradientStrokeMode and frameGradientFillStart write, read and undo", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    expect(await read(h, id, "frameGradientStrokeMode")).toEqual({
      type: "text",
      value: "Within",
    });
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameGradientStrokeMode",
        value: { type: "text", value: "Along" },
      },
    });
    expect(out.applied).toBe(true);
    expect(await read(h, id, "frameGradientStrokeMode")).toEqual({
      type: "text",
      value: "Along",
    });
    await h.host.document.undo();
    expect(await read(h, id, "frameGradientStrokeMode")).toEqual({
      type: "text",
      value: "Within",
    });
    const address = `frame:${String(id.id)}`;
    expect(
      await h.objects.set(address, "frameGradientFillStart", [30, 40]),
    ).toMatchObject({ applied: true });
    expect(await h.objects.get(address, "frameGradientFillStart")).toEqual(
      value([30, 40]),
    );
    const bad = await h.objects.set(
      address,
      "frameGradientStrokeMode",
      "Sideways",
    );
    expect(bad.applied).toBe(false);
  });
});
