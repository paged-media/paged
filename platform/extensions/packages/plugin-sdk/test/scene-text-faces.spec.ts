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

// Protocol 68 — scene-layer text in its own face (core ADR 126). The engine
// resolves each text item's family / style / weight / italic through the
// document's registered fonts and reports the faces that fell back to the
// default font on the `sceneLayerApplied` reply. The SDK forwards the item
// fields untouched and hands the report back from `submit`.

import { describe, expect, it } from "vitest";

import type { PagedEditor, PluginManifest, SceneLayer } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.web",
  name: "web",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { rendering: ["sceneLayer"] },
};

const LAYER: SceneLayer = {
  items: [
    {
      kind: "text",
      x: 0,
      y: 12,
      text: "Heading",
      size: 24,
      paint: { r: 0, g: 0, b: 0, a: 1 },
      family: "Inter",
      weight: 700,
      italic: true,
    },
  ],
};

function host(reply: "v68" | "older" | "none") {
  const fake = makeFakeEditor();
  const sent: SceneLayer[] = [];
  const sceneLayers: NonNullable<PagedEditor["sceneLayers"]> = {
    async submit(_id, layer) {
      sent.push(layer);
      if (reply === "v68") return { fontFallbacks: ["Inter Bold Italic"] };
      return undefined;
    },
    async clear() {},
  };
  if (reply !== "none") {
    (fake.editor as unknown as { sceneLayers: unknown }).sceneLayers = sceneLayers;
  }
  const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
  return { host, sent };
}

describe("sceneLayer text faces (protocol 68)", () => {
  it("forwards the face fields and returns the engine's fallback report", async () => {
    const { host: h, sent } = host("v68");
    expect(h.supports("rendering.sceneLayer.faces@1")).toBe(true);
    const result = await h.contribute.sceneLayer().submit("tf1", LAYER);
    expect(result.fontFallbacks).toEqual(["Inter Bold Italic"]);
    expect(sent[0].items[0]).toMatchObject({ family: "Inter", weight: 700, italic: true });
  });

  it("reads an older host's void reply as no report, never a guess", async () => {
    const { host: h } = host("older");
    const result = await h.contribute.sceneLayer().submit("tf1", LAYER);
    expect(result.fontFallbacks).toEqual([]);
  });

  it("has no faces flag without a scene channel", async () => {
    const { host: h } = host("none");
    expect(h.supports("rendering.sceneLayer@1")).toBe(false);
    expect(h.supports("rendering.sceneLayer.faces@1")).toBe(false);
    const result = await h.contribute.sceneLayer().submit("tf1", LAYER);
    expect(result.fontFallbacks).toEqual([]);
  });
});
