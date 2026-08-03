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

// The overlay TEXT primitive (RFI "the overlay channel carries shapes
// only, no text primitive" — consumer: paged.draw's Measure tool
// readout). Coverage:
//   1. the pass-through: a `ToolPreviewText` reaches the editor's
//      overlay signals VERBATIM through the existing tool-preview
//      channel (no re-shaping in the adapter);
//   2. the flag: `supports("overlay.text@1")` answers true (static,
//      like overlay.toolPreview@1 — the renderer ships with the host);
//   3. the gate: the same `capabilities.rendering ∋ "overlay"` gate as
//      every other preview variant (one channel, one gate).

import { describe, expect, it } from "vitest";

import type { PluginManifest, ToolPreviewText } from "@paged-media/plugin-api";

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

function makeHost(caps: PluginManifest["capabilities"] = {}) {
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

describe("overlay.text — the tool-preview TEXT primitive", () => {
  it("passes a ToolPreviewText through to the overlay signals verbatim", () => {
    const { host, fake } = makeHost({ rendering: ["overlay"] });
    const preview: ToolPreviewText = {
      kind: "text",
      pageId: "p1",
      x: 120,
      y: 80,
      text: "W 24 pt · H 13.5 pt",
      size: 11,
      anchor: "middle",
      background: true,
    };
    host.overlay.setToolPreview(preview);
    // Verbatim — the adapter is a pass-through, never a re-shaper (the
    // host renderer owns sanitizing + layout).
    expect(fake.getToolPreview()).toEqual(preview);

    // Clearing rides the same channel.
    host.overlay.setToolPreview(null);
    expect(fake.getToolPreview()).toBeNull();
  });

  it("supports('overlay.text@1') answers true (the vocabulary flag)", () => {
    const { host } = makeHost({ rendering: ["overlay"] });
    expect(host.supports("overlay.text@1")).toBe(true);
  });

  it("rides the SAME rendering-'overlay' capability gate as the other variants", () => {
    const { host } = makeHost({ rendering: [] });
    expect(() =>
      host.overlay.setToolPreview({
        kind: "text",
        pageId: "p1",
        x: 0,
        y: 0,
        text: "x",
      }),
    ).toThrow(PluginCapabilityError);
  });
});
