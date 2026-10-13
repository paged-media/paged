/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// `host.selection.set` must leave the host where a click leaves it: the
// selection set AND the geometry the selection box is drawn from. It set
// only the selection, so after paged.sheet placed a chart and selected
// its group, the control bar said "Group" while the box stayed on the
// table that was selected before.

import { describe, expect, it } from "vitest";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor } from "./fake-editor";

const MANIFEST: PluginManifest = {
  id: "media.paged.selgeom",
  name: "selgeom",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { write: "broad" } },
};

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function setup() {
  const fake = makeFakeEditor();
  const { host } = createBundleHost(() => fake.editor, MANIFEST, {
    console: silent,
    capabilityMode: "enforce",
  });
  return { fake, host };
}

const geometryOf = (id: ElementId) => ({
  id,
  pageId: "p1",
  spreadId: "s1",
  bounds: [10, 20, 30, 40],
  itemTransform: null,
  hasImage: false,
});

describe("selection.set refreshes the selection geometry", () => {
  it("writes the engine's geometry for the APPLIED ids to the mirror", async () => {
    const { fake, host } = setup();
    const table = { kind: "rectangle", id: "uTable" } as ElementId;
    const frame = { kind: "textFrame", id: "uFrame" } as ElementId;
    // The engine has the last word on what is selectable: here it drops
    // the table and keeps the frame.
    fake.editor.client.setElementSelection = async () => [frame];
    const asked: unknown[][] = [];
    fake.setElementGeometryReply((ids) => {
      asked.push(ids);
      return (ids as ElementId[]).map(geometryOf);
    });

    const applied = await host.selection.set([table, frame]);

    expect(applied).toEqual([frame]);
    expect(fake.editor.selection.elementSelection).toEqual([frame]);
    expect(asked).toEqual([[frame]]);
    expect(fake.geometryWrites).toEqual([[geometryOf(frame)]]);
  });

  it("a group, which has no geometry of its own, clears the previous box", async () => {
    const { fake, host } = setup();
    const table = { kind: "rectangle", id: "uTable" } as ElementId;
    const chart = { kind: "group", id: "uChart" } as ElementId;
    // What engine 0.71.8 answers: a page item's geometry, nothing for a group.
    fake.setElementGeometryReply((ids) =>
      (ids as ElementId[]).filter((id) => id.kind !== "group").map(geometryOf),
    );

    await host.selection.set([table]);
    await host.selection.set([chart]);

    expect(fake.editor.selection.elementSelection).toEqual([chart]);
    // The box the user sees is the LAST write: not the table any more.
    expect(fake.geometryWrites.at(-1)).toEqual([]);
  });

  it("a failed geometry read never fails the selection", async () => {
    const { fake, host } = setup();
    const frame = { kind: "textFrame", id: "uFrame" } as ElementId;
    fake.setElementGeometryReply(() => {
      throw new Error("worker gone");
    });

    await expect(host.selection.set([frame])).resolves.toEqual([frame]);
    expect(fake.editor.selection.elementSelection).toEqual([frame]);
    expect(fake.geometryWrites).toEqual([]);
  });
});
