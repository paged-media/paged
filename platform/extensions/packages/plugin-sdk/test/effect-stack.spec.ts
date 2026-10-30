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
// Engine ADR 1008 — the ordered effect stack through the SDK's doors on
// the real engine: the feature flag, the vendored catalog row, a
// `setElementProperty` write of the whole stack, `host.objects` reading
// and writing it as its list of entries, a refusal, and one undo step.

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

describe("frameEffectStack (engine ADR 1008) [effects-transparency.effect-stack]", () => {
  it("is advertised, and the vendored catalog carries the four rows", () => {
    expect(HOST_FEATURES).toContain("document.effectStack@1");
    const rows = (
      propertySchemas as ReadonlyArray<{
        path: string;
        wire?: string;
        type: { kind: string };
      }>
    ).filter((r) => r.path.endsWith("EffectStack"));
    expect(rows.map((r) => r.path).sort()).toEqual([
      "frameContentEffectStack",
      "frameEffectStack",
      "frameFillEffectStack",
      "frameStrokeEffectStack",
      // Engine ADR 1042 — a group's vector effects.
      "groupEffectStack",
    ]);
    for (const r of rows) {
      expect(r.type.kind).toBe("list");
      expect(r.wire).toBe("effectStack");
    }
  });

  it("host.objects reads and writes the stack as its entries; one undo restores it", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.effectStack@1")).toBe(true);
    const id = await frameOn(h);
    const address = `frame:${String(id.id)}`;
    expect(await h.objects.get(address, "frameEffectStack")).toEqual({
      kind: "value",
      value: [],
    });
    const out = await h.objects.set(address, "frameEffectStack", [
      { kind: "gaussianBlur", enabled: true, radiusPt: 3 },
      { kind: "outlineStroke", enabled: true, sizePt: 4 },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    const read = await h.objects.get(address, "frameEffectStack");
    expect(kinds(read)).toEqual(["gaussianBlur", "outlineStroke"]);
    await h.host.document.undo();
    expect(await h.objects.get(address, "frameEffectStack")).toEqual({
      kind: "value",
      value: [],
    });
  });

  it("a stack-only effect on the fill target is refused", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameFillEffectStack",
        value: {
          type: "effectStack",
          value: { entries: [{ kind: "gaussianBlur", enabled: true }] },
        },
      },
    });
    expect(out.applied).toBe(false);
  });
});
