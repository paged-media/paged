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

// REMOVE BACKGROUND as an action (extensions ADR 344 + 1100, engine-free): any
// bundle can run `media.paged.image/remove-background` on a picture and the
// host's ML service cuts the foreground out. The service here is the SDK's
// fake provider (deterministic: pixels brighter than mid-grey are foreground),
// so nothing downloads and no model is bundled; the real local host is the
// same door behind `supports("ml.matting@1")`. The engine is a stand-in with
// the four calls the action makes, so this runs without the built wasm.

import { describe, expect, it } from "bun:test";

import type { ActionAsset, PluginManifest } from "@paged-media/plugin-api";
import {
  createActionRegistry,
  createBundleHost,
  createMlRegistry,
  fakeMlProvider,
} from "@paged-media/plugin-sdk";

import {
  applyForegroundMask,
  IMAGE_ACTION_IDS,
  imageActions,
  registerImageActions,
} from "../src/actions";
import type { ImageEngine } from "../src/engine";
import { makeFakeEditor, silentConsole } from "./helpers";

const W = 2;
const H = 2;
/** Two bright pixels (foreground to the fake model), two dark, one half
 *  transparent to prove the alpha multiplies. */
const PIXELS = new Uint8Array([
  250, 250, 250, 255, 10, 10, 10, 255, 240, 240, 240, 128, 20, 20, 20, 255,
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

function stubEngine(): { engine: ImageEngine; encoded: Uint8Array[] } {
  const encoded: Uint8Array[] = [];
  const engine = {
    decode: () => ({
      handle: 1,
      width: W,
      height: H,
      display: "srgb",
      depthReduced: false,
    }),
    tile: () => new Uint8Array(PIXELS),
    freeImage: () => {},
    encodeOpt: (rgba: Uint8Array) => {
      encoded.push(new Uint8Array(rgba));
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    },
  } as unknown as ImageEngine;
  return { engine, encoded };
}

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { ml: ["matting", "segment"] },
};

function setup(withModel: boolean) {
  const ml = createMlRegistry();
  const fake = fakeMlProvider();
  if (withModel) fake.attach(ml.register(fake));
  const editor = makeFakeEditor();
  const { host } = createBundleHost(() => editor.editor, MANIFEST, {
    console: silentConsole,
    ml,
    capabilityMode: "enforce",
  });
  return { host, fake };
}

const run = (a: ReturnType<typeof imageActions>, input: unknown) =>
  a
    .find((x) => x.id === IMAGE_ACTION_IDS.removeBackground)!
    .run(input, { format: "png" }, {});

describe("media.paged.image/remove-background", () => {
  it("multiplies the picture's alpha by the model's foreground", async () => {
    const { host, fake } = setup(true);
    const { engine, encoded } = stubEngine();
    const actions = imageActions(async () => engine, host);
    const out = (await run(actions, {
      bytes: PNG,
      mediaType: "image/png",
    })) as ActionAsset;
    expect(out.mediaType).toBe("image/png");
    const rgba = encoded[0]!;
    // bright opaque: kept; dark: cleared; bright half-transparent: stays half
    expect(Array.from(rgba).filter((_, i) => i % 4 === 3)).toEqual([
      255, 0, 128, 0,
    ]);
    // colour is untouched
    expect(Array.from(rgba.subarray(0, 3))).toEqual([250, 250, 250]);
    expect(fake.calls.map((c) => c.capability)).toEqual(["matting"]);
  });

  it("rejects, naming what is missing, when no model is served", async () => {
    const { host } = setup(false);
    const { engine, encoded } = stubEngine();
    const actions = imageActions(async () => engine, host);
    await expect(
      run(actions, { bytes: PNG, mediaType: "image/png" }),
    ).rejects.toThrow(/no model installed/);
    expect(encoded).toHaveLength(0);
  });

  it("is not defined without a host, and is chained from another bundle through the registry", async () => {
    expect(
      imageActions(async () => stubEngine().engine).map((a) => a.id),
    ).not.toContain(IMAGE_ACTION_IDS.removeBackground);

    const registry = createActionRegistry();
    const { host } = setup(true);
    const editor = makeFakeEditor();
    const owner = createBundleHost(
      () => editor.editor,
      {
        ...MANIFEST,
        capabilities: { ...MANIFEST.capabilities, actions: { register: true } },
      },
      { console: silentConsole, actions: registry, ml: undefined },
    ).host;
    // register the real definitions on the shared registry through a host
    // that serves the model
    const sub = registerImageActions(
      Object.assign(Object.create(owner), {
        supports: (f: string) => host.supports(f) || owner.supports(f),
        ml: host.ml,
      }),
      async () => stubEngine().engine,
    );
    expect(sub).not.toBeNull();
    const runner = createBundleHost(
      () => editor.editor,
      {
        id: "media.paged.data",
        name: "data",
        version: "1.0.0",
        apiVersion: "^0.2",
        capabilities: { actions: { run: true } },
      },
      { console: silentConsole, actions: registry },
    ).host;
    const res = await runner.actions.run(IMAGE_ACTION_IDS.removeBackground, {
      bytes: PNG,
      mediaType: "image/png",
    });
    expect((res.output as ActionAsset).mediaType).toBe("image/png");
    sub!.dispose();
  });
});

describe("applyForegroundMask", () => {
  it("scales alpha by mask/255", () => {
    const px = new Uint8Array([1, 2, 3, 200, 4, 5, 6, 255]);
    applyForegroundMask(px, new Uint8Array([128, 255]));
    expect([px[3], px[7]]).toEqual([100, 255]);
  });
});
