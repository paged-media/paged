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

// K-9 — the MULTI-shape tool preview (RFI "setToolPreview is
// single-slot: one shape per tool, last write wins"). Consumers:
// paged.draw's Measure (geometry AND readout at once instead of the
// pointer-up swap) and its region Shape Builder (shade every collected
// face, not just the hovered one). Coverage:
//   1. the pass-through: the LIST reaches a wired multi-shape sink
//      verbatim — the adapter never re-shapes a preview;
//   2. the premise: geometry + a text label ride TOGETHER (the thing
//      the single slot made impossible);
//   3. the DEGRADATION: on a host with no multi-shape sink the door
//      forwards the FIRST shape through the single slot (the pre-K-9
//      behaviour) and never throws;
//   4. the flag: `supports("overlay.multiPreview@1")` is DYNAMIC — true
//      only when a real sink is wired;
//   5. clearing: `null` AND `[]` both clear, on either host;
//   6. the gate: the same `capabilities.rendering ∋ "overlay"` gate as
//      `setToolPreview` — one channel, one gate.

import { describe, expect, it } from "vitest";

import type {
  PluginManifest,
  ToolPreviewShape,
  ToolPreviewText,
} from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = {},
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

function makeHost(
  caps: PluginManifest["capabilities"] = { rendering: ["overlay"] },
  multiPreview = true,
) {
  const fake = makeFakeEditor({ multiPreview });
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

/** The Measure tool's pair, verbatim: the measured segment PLUS the
 *  readout that used to replace it at pointer-up. */
const line: ToolPreviewShape = {
  pageId: "p1",
  points: [
    [10, 10],
    [110, 60],
  ],
};
const readout: ToolPreviewText = {
  kind: "text",
  pageId: "p1",
  x: 60,
  y: 35,
  text: "111.80 pt · 26.6°",
  background: true,
};

describe("overlay.setToolPreviews — the multi-shape tool preview (K-9)", () => {
  it("passes the LIST through to a wired multi-shape sink verbatim", () => {
    const { host, fake } = makeHost();
    host.overlay.setToolPreviews([line, readout]);
    expect(fake.getToolPreviews()).toEqual([line, readout]);
    // One SLOT: the list replaces the single-shape value, it does not
    // stack a second overlay layer beside it.
    expect(fake.getToolPreview()).toBeNull();
  });

  it("carries GEOMETRY and a LABEL at once (the gap this door closes)", () => {
    const { host, fake } = makeHost();
    host.overlay.setToolPreviews([line, readout]);
    const list = fake.getToolPreviews() as ToolPreviewShape[];
    expect(list).toHaveLength(2);
    // The exact trade Measure had to make: the frozen line was swapped
    // for the frozen numbers because the slot held one node.
    expect(list.some((s) => "points" in s)).toBe(true);
    expect(list.some((s) => "kind" in s && s.kind === "text")).toBe(true);
  });

  it("supports('overlay.multiPreview@1') is true only when a sink is wired", () => {
    expect(makeHost().host.supports("overlay.multiPreview@1")).toBe(true);
    expect(
      makeHost({ rendering: ["overlay"] }, false).host.supports(
        "overlay.multiPreview@1",
      ),
    ).toBe(false);
  });

  it("degrades to the FIRST shape on the single slot when no sink is wired", () => {
    const { host, fake } = makeHost({ rendering: ["overlay"] }, false);
    // The pre-K-9 behaviour, now done by the adapter instead of by every
    // consumer — and never a throw.
    expect(() => host.overlay.setToolPreviews([line, readout])).not.toThrow();
    expect(fake.getToolPreview()).toEqual(line);
    expect(fake.getToolPreviews()).toBeNull();
  });

  it("null and [] both clear, on a sink host and a single-slot host", () => {
    const wired = makeHost();
    wired.host.overlay.setToolPreviews([line, readout]);
    wired.host.overlay.setToolPreviews(null);
    expect(wired.fake.getToolPreviews()).toBeNull();
    wired.host.overlay.setToolPreviews([line]);
    wired.host.overlay.setToolPreviews([]);
    expect(wired.fake.getToolPreviews()).toBeNull();

    const plain = makeHost({ rendering: ["overlay"] }, false);
    plain.host.overlay.setToolPreviews([line]);
    plain.host.overlay.setToolPreviews([]);
    expect(plain.fake.getToolPreview()).toBeNull();
  });

  it("rides the SAME rendering-'overlay' capability gate as setToolPreview", () => {
    const { host } = makeHost({ rendering: [] });
    expect(() => host.overlay.setToolPreviews([line])).toThrow(
      PluginCapabilityError,
    );
  });
});
