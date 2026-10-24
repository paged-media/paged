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

// WP4.10 — paged.image's COLOUR provider: the host Color panel's fill /
// stroke wells read and write the image's foreground / background, and a
// host swatch (a `colorRef`) is taken through the document's colour
// management. Driven through the REAL shared registry, as the host does.

import { describe, expect, it } from "bun:test";

import {
  createBindingProviderRegistry,
  createBundleHost,
} from "@paged-media/plugin-sdk";
import type { PluginManifest, Value } from "@paged-media/plugin-api";

import manifestJson from "@paged-media/image-manifest/manifest.json";

import { activate } from "../src/activate";
import { createImageSession } from "../src/session";
import {
  makeColorBindingProvider,
  rgbaToValue,
  valueToRgba,
} from "../src/binding-provider/color-provider";
import {
  makeFakeEditor,
  mapBacking,
  shellStub,
  silentConsole,
} from "./helpers";

const PLUGIN = "media.paged.image";
const CTX = "rasterImage";
const SEL = { kind: "selection", scope: "element" } as const;

function rig() {
  const registry = createBindingProviderRegistry();
  const fake = makeFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
      shell: shellStub(),
      bindingProviders: registry,
    },
  );
  const session = createImageSession(handle.host);
  registry.register({
    plugin: PLUGIN,
    contextType: CTX,
    provider: makeColorBindingProvider(handle.host, session).provider,
  });
  registry.setContextActive(PLUGIN, CTX, "u1", true);
  return { registry, session, handle };
}

const rgb = (v: number[]): Value =>
  ({
    type: "swatchColor",
    value: { space: "RGB", value: v, model: "Process" },
  }) as Value;

describe("the colour provider [editor-shell.raster-color-binding]", () => {
  it("activate registers it on the raster context, claiming exactly the two wells", () => {
    const registry = createBindingProviderRegistry();
    const fake = makeFakeEditor();
    const handle = createBundleHost(
      () => fake.editor,
      manifestJson as PluginManifest,
      {
        console: silentConsole,
        storage: mapBacking(),
        shell: shellStub(),
        bindingProviders: registry,
      },
    );
    const bundle = activate(handle.host);
    registry.setContextActive(PLUGIN, CTX, "u1", true);
    const colour = registry
      .activeProviders()
      .find((p) => p.provides.paths?.includes("frameFillColor"));
    expect(colour?.plugin).toBe(PLUGIN);
    expect([...(colour?.provides.paths ?? [])].sort()).toEqual([
      "frameFillColor",
      "frameStrokeColor",
    ]);
    registry.setContextActive(PLUGIN, CTX, "u1", false);
    expect(registry.activeProviders()).toHaveLength(0);
    bundle.dispose();
    handle.dispose();
  });

  it("the fill well reads the foreground, the stroke well the background, as raw RGB", async () => {
    const { registry, handle } = rig();
    const fill = await registry.readProperty({
      path: "frameFillColor",
      target: SEL,
    });
    const stroke = await registry.readProperty({
      path: "frameStrokeColor",
      target: SEL,
    });
    expect(fill).toMatchObject({
      resolved: true,
      provider: PLUGIN,
      read: { kind: "value", value: rgb([0, 0, 0]) },
    });
    expect(stroke).toMatchObject({
      resolved: true,
      read: { kind: "value", value: rgb([255, 255, 255]) },
    });
    handle.dispose();
  });

  it("writing a colour to a well sets the foreground / background", async () => {
    const { registry, session, handle } = rig();
    const w = await registry.writeProperty({
      path: "frameFillColor",
      target: SEL,
      value: rgb([255, 128, 0]),
    });
    expect(w).toMatchObject({
      handled: true,
      outcome: { applied: true, pageIds: [] },
    });
    expect(session.state().colors.fg).toEqual([1, 128 / 255, 0, 1]);
    // The brush paints the new foreground from the next stroke.
    expect(session.state().brush.color).toEqual([1, 128 / 255, 0, 1]);
    await registry.writeProperty({
      path: "frameStrokeColor",
      target: SEL,
      value: {
        type: "swatchColor",
        value: { space: "CMYK", value: [0, 0, 0, 100] },
      } as Value,
    });
    expect(session.state().colors.bg).toEqual([0, 0, 0, 1]);
    handle.dispose();
  });

  it("a host swatch (colorRef) is taken through the document's colour management", async () => {
    const { registry, session, handle } = rig();
    const w = await registry.writeProperty({
      path: "frameFillColor",
      target: SEL,
      value: { type: "colorRef", value: "Color/#3366cc" },
    });
    expect(w).toMatchObject({ handled: true, outcome: { applied: true } });
    expect(session.state().colors.fg).toEqual([
      0x33 / 255,
      0x66 / 255,
      0xcc / 255,
      1,
    ]);
    handle.dispose();
  });

  it("None and unknown swatches are refused by name, never sent to core", async () => {
    const { registry, session, handle } = rig();
    const none = await registry.writeProperty({
      path: "frameFillColor",
      target: SEL,
      value: { type: "colorRef", value: null },
    });
    expect(none).toMatchObject({ handled: true, outcome: { applied: false } });
    const unknown = await registry.writeProperty({
      path: "frameFillColor",
      target: SEL,
      value: { type: "colorRef", value: "Color/Nope" },
    });
    expect(unknown).toMatchObject({
      handled: true,
      outcome: { applied: false },
    });
    const lab = await registry.writeProperty({
      path: "frameFillColor",
      target: SEL,
      value: {
        type: "swatchColor",
        value: { space: "LAB", value: [50, 0, 0] },
      } as Value,
    });
    expect(lab).toMatchObject({ handled: true, outcome: { applied: false } });
    expect(session.state().colors.fg).toEqual([0, 0, 0, 1]);
    handle.dispose();
  });

  it("an image colour change re-reads the wells (no engine mutation tells the host)", async () => {
    const { registry, session, handle } = rig();
    session.swapColors();
    const fill = await registry.readProperty({
      path: "frameFillColor",
      target: SEL,
    });
    expect(fill).toMatchObject({ read: { value: rgb([255, 255, 255]) } });
    handle.dispose();
  });

  it("the value codec round-trips and clamps", () => {
    expect(rgbaToValue([1, 0.5, 0, 1])).toEqual(rgb([255, 128, 0]));
    expect(valueToRgba(rgb([300, -5, 0]))).toEqual({
      ok: true,
      colour: [1, 0, 0, 1],
    });
    expect(valueToRgba({ type: "number", value: 1 } as Value).ok).toBe(false);
  });
});
