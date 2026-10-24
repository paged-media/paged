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

// Engine ADR 1006 — the fill rule is a native frame property. Through the
// SDK's doors on the real engine: the feature flag, the vendored catalog
// row, `setElementProperty` and `host.objects` writes, the read back on
// both read doors, the refusal of a value that is not a rule, and one
// undo step that restores the default.

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

async function ruleOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<string | undefined> {
  const props = await h.host.document.elementProperties(id);
  const v = props?.entries.find((e) => e.path === "frameFillRule")?.value;
  return v?.type === "text" ? (v.value as string) : undefined;
}

describe("frameFillRule (engine ADR 1006) [frames-paths.fill-rule-even-odd]", () => {
  it("is advertised, and the vendored catalog carries its row", () => {
    expect(HOST_FEATURES).toContain("document.fillRule@1");
    const row = (
      propertySchemas as ReadonlyArray<{
        path: string;
        type: { kind: string; members?: string[] };
        default?: unknown;
      }>
    ).find((r) => r.path === "frameFillRule");
    expect(row?.type).toEqual({
      kind: "enum",
      members: ["NonZero", "EvenOdd"],
    });
    expect(row?.default).toBe("NonZero");
  });

  it("a frame reads NonZero, writes EvenOdd, and one undo restores it", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.fillRule@1")).toBe(true);
    const id = await frameOn(h);
    expect(await ruleOf(h, id)).toBe("NonZero");
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameFillRule",
        value: { type: "text", value: "EvenOdd" },
      },
    });
    expect(out.applied).toBe(true);
    expect(await ruleOf(h, id)).toBe("EvenOdd");
    await h.host.document.undo();
    expect(await ruleOf(h, id)).toBe("NonZero");
  });

  it("host.objects sets and gets it on a frame address; a value that is no rule is refused", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const address = `frame:${String(id.id)}`;
    expect(await h.objects.get(address, "frameFillRule")).toEqual(
      value("NonZero"),
    );
    expect(
      await h.objects.set(address, "frameFillRule", "EvenOdd"),
    ).toMatchObject({ applied: true });
    expect(await h.objects.get(address, "frameFillRule")).toEqual(
      value("EvenOdd"),
    );
    const bad = await h.objects.set(address, "frameFillRule", "Winding");
    expect(bad.applied).toBe(false);
    expect(await h.objects.get(address, "frameFillRule")).toEqual(
      value("EvenOdd"),
    );
  });
});
