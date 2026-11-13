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

// Engine ADR 1099 — `document.placePsdLayers@1` against the real engine:
// a file Photoshop wrote (a styled layer over a background) lands as
// frames in ONE undo step, the styled one carrying its layer style as a
// layer-style effect stack; and a host whose engine predates the door
// answers an outcome, never a throw.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { HOST_FEATURES } from "../src/host-impl";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";
import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

// Recorded from Photoshop 27.10 by the layer-styles probe (provenance in
// the fixtures' `layer-styles.photoshop.json`).
const PSD = new Uint8Array(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../engine/core/crates/paged-psd-fx/tests/fixtures/photoshop-layer-styles/ds-basic.psd",
    ),
  ),
);

describe("host.document.placePsdLayers [images-graphics.psd-layer-styles]", () => {
  it("advertises the door", () => {
    expect(HOST_FEATURES).toContain("document.placePsdLayers@1");
  });

  it("places a PSD's layers as frames in one undo step", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    const before = (await live.host.document.tree()).length;
    const result = await live.host.document.placePsdLayers(PSD, {
      pageId,
      origin: [0, 0],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.layers).toBeGreaterThanOrEqual(1);
    const outcome = result.outcome;
    const minted = outcome && outcome.applied ? (outcome.minted ?? []) : [];
    expect(minted.length).toBeGreaterThanOrEqual(result.layers);
    await live.host.document.undo();
    expect((await live.host.document.tree()).length).toBe(before);
  });

  it("answers an outcome on an engine that predates the door", async () => {
    const fake = makeFakeEditor();
    const manifest: PluginManifest = {
      id: "media.paged.test",
      name: "test",
      version: "1.0.0",
      apiVersion: "^0.2",
      capabilities: { document: { read: "broad", write: "broad" } },
    };
    const { host } = createBundleHost(() => fake.editor, manifest, {
      console: silent,
    });
    const placed = await host.document.placePsdLayers(PSD, { pageId: "p1" });
    expect(placed.applied).toBe(false);
    expect(placed.error).toBeDefined();
  });
});
