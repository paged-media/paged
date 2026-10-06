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

// W-20 — `host.overlay.layer()`: retained, data-only overlay layers per
// bundle, beside (never inside) the shared tool-preview slot. Coverage:
//   1. two layers of one bundle hold their shapes independently, and
//      clearing one leaves the other (and the tool preview) alone;
//   2. stack order is CREATION order and survives set/clear;
//   3. dispose drops a layer; disposing the bundle host drops them all;
//   4. ids: generated when omitted, a live duplicate throws;
//   5. the flag is DYNAMIC (both sink members, or false), and on a host
//      with no sink the handle is inert and never touches the slot;
//   6. the gate: `capabilities.rendering ∋ "overlay"`.

import { describe, expect, it } from "vitest";

import type { PluginManifest, ToolPreviewShape } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = { rendering: ["overlay"] },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

const caret: ToolPreviewShape = {
  pageId: "p1",
  points: [
    [20, 10],
    [20, 24],
  ],
};
const outline: ToolPreviewShape = { pageId: "p1", rect: [5, 5, 50, 80] };
const toolRect: ToolPreviewShape = { pageId: "p1", rect: [0, 0, 10, 10] };

function makeHost(overlayLayers = true, caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor({ overlayLayers, multiPreview: true });
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

describe("host.overlay.layer — retained per-bundle layers (W-20)", () => {
  it("two layers and the tool preview coexist and clear independently", () => {
    const { host, fake } = makeHost();
    const a = host.overlay.layer("caret");
    const b = host.overlay.layer("outline");
    a.set([caret]);
    b.set([outline]);
    host.overlay.setToolPreviews([toolRect]);
    expect(fake.getOverlayLayers()).toEqual([
      { key: "media.paged.test/caret", shapes: [caret] },
      { key: "media.paged.test/outline", shapes: [outline] },
    ]);

    a.clear();
    expect(fake.getOverlayLayers()).toEqual([
      { key: "media.paged.test/caret", shapes: [] },
      { key: "media.paged.test/outline", shapes: [outline] },
    ]);
    // The tool-preview slot is a different channel: untouched by layers.
    expect(fake.getToolPreviews()).toEqual([toolRect]);

    host.overlay.setToolPreviews(null);
    expect(fake.getOverlayLayers()[1].shapes).toEqual([outline]);
  });

  it("stacks in creation order, kept across set and clear", () => {
    const { host, fake } = makeHost();
    const first = host.overlay.layer("first");
    const second = host.overlay.layer("second");
    second.set([outline]);
    first.set([caret]);
    first.clear();
    first.set([caret, outline]);
    expect(fake.getOverlayLayers().map((l) => l.key)).toEqual([
      "media.paged.test/first",
      "media.paged.test/second",
    ]);
  });

  it("set copies the array (a later mutation by the bundle does not leak)", () => {
    const { host, fake } = makeHost();
    const l = host.overlay.layer("x");
    const shapes: ToolPreviewShape[] = [caret];
    l.set(shapes);
    shapes.push(outline);
    expect(fake.getOverlayLayers()[0].shapes).toEqual([caret]);
  });

  it("dispose drops one layer; the bundle teardown drops the rest", () => {
    const { host, fake, dispose } = makeHost();
    const a = host.overlay.layer("a");
    host.overlay.layer("b").set([outline]);
    a.dispose();
    a.set([caret]); // after dispose: inert
    expect(fake.getOverlayLayers().map((l) => l.key)).toEqual([
      "media.paged.test/b",
    ]);
    // The id is free again once disposed.
    host.overlay.layer("a");
    dispose();
    expect(fake.getOverlayLayers()).toEqual([]);
  });

  it("generates ids when omitted and refuses a live duplicate", () => {
    const { host } = makeHost();
    const a = host.overlay.layer();
    const b = host.overlay.layer();
    expect(a.id).not.toBe(b.id);
    host.overlay.layer("dup");
    expect(() => host.overlay.layer("dup")).toThrow(/already live/);
  });

  it("supports('overlay.layers@1') only when both sink members are wired", () => {
    expect(makeHost(true).host.supports("overlay.layers@1")).toBe(true);
    expect(makeHost(false).host.supports("overlay.layers@1")).toBe(false);
  });

  it("without a sink the layer is inert and never writes the tool-preview slot", () => {
    const { host, fake } = makeHost(false);
    const l = host.overlay.layer("caret");
    expect(() => l.set([caret])).not.toThrow();
    l.clear();
    l.dispose();
    expect(fake.getToolPreview()).toBeNull();
    expect(fake.getToolPreviews()).toBeNull();
  });

  it("is gated on capabilities.rendering including overlay", () => {
    const { host } = makeHost(true, {});
    expect(() => host.overlay.layer("x")).toThrow(PluginCapabilityError);
  });

  it("the headless harness renders layers and records them in order", async () => {
    const h = await createHeadlessHost({ console: silent });
    try {
      expect(h.host.supports("overlay.layers@1")).toBe(true);
      const a = h.host.overlay.layer("a");
      const b = h.host.overlay.layer("b");
      b.set([outline]);
      a.set([caret]);
      expect(h.overlayLayers()).toEqual([
        { key: "media.paged.harness/a", shapes: [caret] },
        { key: "media.paged.harness/b", shapes: [outline] },
      ]);
      b.dispose();
      expect(h.overlayLayers().map((l) => l.key)).toEqual([
        "media.paged.harness/a",
      ]);
    } finally {
      h.dispose();
    }
  });
});
