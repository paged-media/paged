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

// C-16 — the per-element PARENTAGE read (RFI "host.document exposes no
// parentOf, so paged.draw's selectParentGroup re-reads the WHOLE scene
// tree on every press"). NO core door was needed: the existing
// `requestSceneTree` reply already carries parentage; what was missing
// was a per-element read + a cache. Coverage:
//   1. the answer: the nearest ANCESTOR ELEMENT, one level and nested;
//   2. non-element containers (Page / Spread rows carry no ElementId)
//      are transparent — a top-level frame answers null, and a frame
//      inside a group nested under a page answers the GROUP;
//   3. the point of the door: repeated reads cost ONE scene-tree query;
//   4. freshness: an applied mutation drops the index, so the next read
//      re-queries (as fresh as `tree()`, never fresher);
//   5. structural addresses (storyRange/table) answer null WITHOUT a
//      read — they never nest in groups;
//   6. the gate: `capabilities.document.read`, like every read door.

import { describe, expect, it } from "vitest";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = {
    document: { read: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

const frame = (id: string) => ({ kind: "rectangle", id }) as ElementId;
const group = (id: string) => ({ kind: "group", id }) as ElementId;

/** Spread → Page → [ group g1 → [ rect r1, group g2 → [ rect r2 ] ],
 *                    rect top ]. Spread/Page rows carry NO ElementId. */
const ROOTS = [
  {
    kind: "spread",
    label: "Spread 1",
    children: [
      {
        kind: "page",
        label: "Page 1",
        children: [
          {
            id: group("g1"),
            kind: "group",
            label: "Group",
            children: [
              { id: frame("r1"), kind: "rectangle", label: "R1" },
              {
                id: group("g2"),
                kind: "group",
                label: "Nested group",
                children: [{ id: frame("r2"), kind: "rectangle", label: "R2" }],
              },
            ],
          },
          { id: frame("top"), kind: "rectangle", label: "Top-level" },
        ],
      },
    ],
  },
];

function makeHost(caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor();
  fake.setSceneTree(ROOTS);
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

const treeReads = (fake: ReturnType<typeof makeHost>["fake"]) =>
  fake.sent.filter((m) => m.kind === "requestSceneTree").length;

describe("document.parentOf — the per-element parentage read (C-16)", () => {
  it("answers the containing group, one level and nested", async () => {
    const { host } = makeHost();
    await expect(host.document.parentOf(frame("r1"))).resolves.toEqual(
      group("g1"),
    );
    // Nested: the NEAREST ancestor element, not the outermost.
    await expect(host.document.parentOf(frame("r2"))).resolves.toEqual(
      group("g2"),
    );
    await expect(host.document.parentOf(group("g2"))).resolves.toEqual(
      group("g1"),
    );
  });

  it("is null for a top-level item — a Page is not an element", async () => {
    const { host } = makeHost();
    // The Spread/Page rows carry no ElementId, so they are transparent:
    // the item has no ELEMENT parent, which is the selectable truth.
    await expect(host.document.parentOf(frame("top"))).resolves.toBeNull();
    await expect(host.document.parentOf(group("g1"))).resolves.toBeNull();
  });

  it("is null for an id that does not resolve", async () => {
    const { host } = makeHost();
    await expect(host.document.parentOf(frame("nope"))).resolves.toBeNull();
  });

  it("costs ONE scene-tree read across repeated presses (the whole point)", async () => {
    const { host, fake } = makeHost();
    await host.document.parentOf(frame("r1"));
    await host.document.parentOf(frame("r2"));
    await host.document.parentOf(frame("top"));
    // Before this door, selectParentGroup walked the entire tree per
    // invocation — O(document) per press.
    expect(treeReads(fake)).toBe(1);
  });

  it("re-reads after an applied change (as fresh as tree(), never fresher)", async () => {
    const { host, fake } = makeHost();
    await host.document.parentOf(frame("r1"));
    expect(treeReads(fake)).toBe(1);
    fake.emit({ kind: "mutationApplied", payload: { pageIds: ["p1"] } });
    await host.document.parentOf(frame("r1"));
    expect(treeReads(fake)).toBe(2);
    // Undo/redo invalidate the same way.
    fake.emit({ kind: "undoApplied", payload: { pageIds: ["p1"] } });
    await host.document.parentOf(frame("r1"));
    expect(treeReads(fake)).toBe(3);
  });

  it("answers null for a structural address WITHOUT reading the tree", async () => {
    const { host, fake } = makeHost();
    await expect(
      host.document.parentOf({
        kind: "storyRange",
        id: { story_id: "s1", start: 0, end: 4 },
      } as ElementId),
    ).resolves.toBeNull();
    expect(treeReads(fake)).toBe(0);
  });

  it("is gated on capabilities.document.read", async () => {
    const { host } = makeHost({});
    await expect(host.document.parentOf(frame("r1"))).rejects.toThrow();
  });

  it("supports('document.parentOf@1') is true (served without a core door)", () => {
    expect(makeHost().host.supports("document.parentOf@1")).toBe(true);
  });
});
