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

// Engine ADR 1010 — clip groups and groups pasted into a frame, through
// the SDK's doors on the real engine: the feature flag and the catalog
// row, `createGroup { clip: true }` and its `tree()` row, the `groupClip`
// read, a group pasted into a frame listed under it, and one undo each.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";

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

async function framesOn(h: HeadlessHost, n: number): Promise<ElementId[]> {
  const [pageId] = await h.load(minimalIdml());
  const out: ElementId[] = [];
  for (let i = 0; i < n; i++) {
    const made = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: pageId!, bounds: [20 + i * 10, 20, 120 + i * 10, 120] },
    });
    if (!made.applied || !made.createdId) throw new Error("no frame inserted");
    out.push(made.createdId);
  }
  return out;
}

/** Every row of the tree, depth first. */
function rows(nodes: readonly SceneTreeNode[]): SceneTreeNode[] {
  return nodes.flatMap((n) => [n, ...rows(n.children ?? [])]);
}

const idsOf = (n: SceneTreeNode | undefined) =>
  (n?.children ?? []).map((c) => String(c.id?.id));

describe("clip groups (engine ADR 1010) [frames-paths.clip-groups]", () => {
  it("is advertised, and the vendored catalog carries the groupClip row", () => {
    expect(HOST_FEATURES).toContain("document.clipGroups@1");
    const row = (
      propertySchemas as ReadonlyArray<{
        path: string;
        type: { kind: string };
        default?: unknown;
      }>
    ).find((r) => r.path === "groupClip");
    expect(row?.type.kind).toBe("bool");
    expect(row?.default).toBe(false);
  });

  it("createGroup { clip: true } makes a clip group the tree marks; one undo removes it", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.clipGroups@1")).toBe(true);
    const [a, b, path] = await framesOn(h, 3);
    const out = await h.host.document.mutate({
      op: "createGroup",
      args: { memberIds: [a!, b!, path!], clip: true },
    });
    if (!out.applied) throw new Error("createGroup refused");
    const group = out.createdId!;
    const row = rows(await h.host.document.tree()).find(
      (n) => n.id?.id === group.id,
    );
    expect(row?.clip).toBe(true);
    expect(idsOf(row)).toEqual([a, b, path].map((x) => String(x!.id)));
    const props = await h.host.document.elementProperties(group);
    const clip = props?.entries.find((e) => e.path === "groupClip")?.value;
    expect(clip).toEqual({ type: "bool", value: true });
    await h.host.document.undo();
    expect(
      rows(await h.host.document.tree()).some((n) => n.id?.id === group.id),
    ).toBe(false);
  });

  it("a group pastes into a frame and is listed under it; a member stands for its group", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [a, b, frame] = await framesOn(h, 3);
    const grouped = await h.host.document.mutate({
      op: "createGroup",
      args: { memberIds: [a!, b!] },
    });
    if (!grouped.applied) throw new Error("createGroup refused");
    const group = grouped.createdId!;
    const pasted = await h.host.document.mutate({
      op: "pasteInto",
      args: { containerId: frame!, childId: a! },
    });
    expect(pasted.applied).toBe(true);
    const host = rows(await h.host.document.tree()).find(
      (n) => n.id?.id === frame!.id,
    );
    expect(idsOf(host)).toEqual([String(group.id)]);
    expect(await h.host.document.parentOf(group)).toEqual(frame!);
    await h.host.document.undo();
    const back = rows(await h.host.document.tree()).find(
      (n) => n.id?.id === frame!.id,
    );
    expect(idsOf(back)).toEqual([]);
  });
});
