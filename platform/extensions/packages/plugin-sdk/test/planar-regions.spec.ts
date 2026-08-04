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

// B-22 / K-11 — the planar-REGION read door (`host.document.planarRegions`)
// plus the seven v57 region mutations it feeds. Consumer: paged.draw's
// Shape Builder (hover query → face id → `pathfinderFaces`) and its six
// `Pathfinder: <verb>` commands, both of which reach the engine through
// the v0 `host.editor.client.send` escape hatch until this ships.
// Coverage:
//   1. the pass-through: arguments reach the wire as
//      `requestPlanarRegions { elementIds, point? }` and the engine's
//      result comes back VERBATIM — the full shape, not a face array
//      (inputCount / complete survive, `point`-less form omits `point`);
//   2. the REFUSAL channel: `found: false` + `reason` surfaces as-is,
//      never flattened into "no regions" (the whole point of the door);
//   3. `complete: false` — real faces that do not tile the union —
//      reaches the caller intact;
//   4. the no-backend door: a host whose engine predates v57 (the fake
//      never answers the kind) gets a TYPED refusal, not a throw; same
//      for a rejecting channel;
//   5. the mutations: the seven v57 ops ride `document.mutate` at their
//      exact wire shapes (type-level assignability + recorded payload).

import { describe, expect, it } from "vitest";

import type {
  ElementId,
  MutationInput,
  PlanarRegionsResult,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = {
    document: { read: "broad", write: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

function makeHost(caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

const A: ElementId = { kind: "polygon", id: "u100" };
const B: ElementId = { kind: "oval", id: "u200" };

/** Two overlapping inputs → three faces; the shape the v57 engine
 *  answers (camelCase, raw path space). */
const twoFaces: PlanarRegionsResult = {
  found: true,
  faces: [
    {
      id: "0#0",
      signature: [0],
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [10, 0], left: [10, 0], right: [10, 0] },
        { anchor: [10, 10], left: [10, 10], right: [10, 10] },
      ],
      subpathStarts: [0],
      area: 50,
      inside: [3, 3],
    },
    {
      id: "0-1#0",
      signature: [0, 1],
      anchors: [
        { anchor: [5, 5], left: [5, 5], right: [5, 5] },
        { anchor: [10, 5], left: [10, 5], right: [10, 5] },
        { anchor: [10, 10], left: [10, 10], right: [10, 10] },
      ],
      subpathStarts: [0],
      area: 12.5,
      inside: [8, 8],
    },
  ],
  inputCount: 2,
  complete: true,
  reason: null,
};

describe("host.document.planarRegions — the B-22 region read door", () => {
  it("passes elementIds + point through and returns the full result verbatim", async () => {
    const { host, fake } = makeHost();
    fake.setPlanarRegionsReply({
      kind: "planarRegions",
      payload: { result: twoFaces },
    });

    // ---- the hover form: a point narrows the query to one face -------
    const hovered = await host.document.planarRegions([A, B], [8, 8]);
    expect(fake.sent.at(-1)).toEqual({
      kind: "requestPlanarRegions",
      payload: { elementIds: [A, B], point: [8, 8] },
    });
    // VERBATIM — the adapter is a pass-through, never a re-shaper: the
    // faces AND the inputCount / complete / reason envelope survive.
    expect(hovered).toEqual(twoFaces);
    expect(hovered.inputCount).toBe(2);
    expect(hovered.complete).toBe(true);
    expect(hovered.faces[1].id).toBe("0-1#0");
    // The face id is the token that rides straight into pathfinderFaces.
    expect(hovered.faces.map((f) => f.id)).toEqual(["0#0", "0-1#0"]);

    // ---- the enumeration form: no point ⇒ no `point` on the wire -----
    const all = await host.document.planarRegions([A, B]);
    expect(fake.sent.at(-1)).toEqual({
      kind: "requestPlanarRegions",
      payload: { elementIds: [A, B] },
    });
    expect(all).toEqual(twoFaces);
  });

  it("surfaces a REFUSAL (found:false + reason) instead of an empty face list", async () => {
    const { host, fake } = makeHost();
    const refused: PlanarRegionsResult = {
      found: false,
      faces: [],
      inputCount: 0,
      complete: false,
      reason: "more than 12 inputs (MAX_PLANAR_INPUTS)",
    };
    fake.setPlanarRegionsReply({
      kind: "planarRegions",
      payload: { result: refused },
    });

    const result = await host.document.planarRegions([A, B]);
    // The distinction the door exists for: this is NOT "these paths
    // divide into nothing" — the caller must be able to tell, and does.
    expect(result.found).toBe(false);
    expect(result.reason).toBe("more than 12 inputs (MAX_PLANAR_INPUTS)");
    expect(result).toEqual(refused);
  });

  it("carries `complete:false` through — real faces that do not tile the union", async () => {
    const { host, fake } = makeHost();
    fake.setPlanarRegionsReply({
      kind: "planarRegions",
      payload: { result: { ...twoFaces, complete: false } },
    });
    const result = await host.document.planarRegions([A, B]);
    expect(result.found).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.faces).toHaveLength(2);
  });

  it("answers a TYPED refusal (never throws) when no v57 backend answers", async () => {
    // The default fake never answers `requestPlanarRegions` — a host
    // whose engine predates protocol 57.
    const { host } = makeHost();
    expect(host.supports("document.planarRegions@1")).toBe(true);

    const result = await host.document.planarRegions([A, B], [1, 1]);
    expect(result.found).toBe(false);
    expect(result.faces).toEqual([]);
    // The refusal is honest about WHOSE limit it is, and reports the
    // input count it was asked about.
    expect(result.inputCount).toBe(2);
    expect(result.complete).toBe(false);
    expect(String(result.reason)).toContain("protocol v57");
  });

  it("answers a typed refusal when the channel itself fails", async () => {
    const fake = makeFakeEditor();
    const editor = fake.editor;
    editor.client.send = async () => {
      throw new Error("worker gone");
    };
    const { host } = createBundleHost(() => editor, manifest(), {
      console: silent,
      capabilityMode: "enforce",
    });
    const result = await host.document.planarRegions([A]);
    expect(result.found).toBe(false);
    expect(String(result.reason)).toContain("worker gone");
  });

  it("rides the document.read capability gate like every other read door", async () => {
    const { host } = makeHost({ document: { write: "broad" } });
    await expect(host.document.planarRegions([A])).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });
});

describe("the v57 region mutations (B-22) — the PendingMutation lane", () => {
  it("carries the seven region ops through mutate at their wire shapes", async () => {
    const { host, fake } = makeHost();

    // Type-level pin: each op is an accepted `MutationInput` at the EXACT
    // wire shape (`elementIds` top-to-bottom, index 0 frontmost). A drift
    // in mutations.ts fails `pnpm typecheck`, not just this assertion.
    const verbs: MutationInput[] = [
      { op: "pathfinderDivide", args: { elementIds: [A, B] } },
      { op: "pathfinderTrim", args: { elementIds: [A, B] } },
      { op: "pathfinderMerge", args: { elementIds: [A, B] } },
      { op: "pathfinderCrop", args: { elementIds: [A, B] } },
      { op: "pathfinderOutline", args: { elementIds: [A, B] } },
      { op: "pathfinderMinusBack", args: { elementIds: [A, B] } },
      {
        op: "pathfinderFaces",
        args: { elementIds: [A, B], faces: ["0-1#0"], mode: "keep" },
      },
    ];

    for (const m of verbs) {
      const outcome = await host.document.mutate(m);
      expect(outcome.applied).toBe(true);
    }

    expect(fake.mutations).toHaveLength(7);
    expect(fake.mutations[0]).toEqual({
      op: "pathfinderDivide",
      args: { elementIds: [A, B] },
    });
    // Shape Builder's commit: the face ids the read door reported, plus
    // the keep/remove mode (drag vs alt-drag).
    expect(fake.mutations[6]).toEqual({
      op: "pathfinderFaces",
      args: { elementIds: [A, B], faces: ["0-1#0"], mode: "keep" },
    });
  });
});
