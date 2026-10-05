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

// v67 (RFI C-68) — `host.document.snapPoint`, the engine's point snapper.
// The fake-editor half pins the adapter (a verbatim pass-through, and an
// UNSNAPPED answer where an older engine stays silent); the headless half
// runs the real engine's resolver once, so the wire shape is the one the
// engine speaks.

import { afterEach, describe, expect, it } from "vitest";

import type { PluginManifest, SnapPointResult } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

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

function makeHost(caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

const query = {
  pageId: "p1",
  point: [101, 99] as [number, number],
  cameraScale: 2,
  exclude: [{ id: { kind: "polygon", id: "u1" }, anchors: [2] }],
  extraPoints: [[40, 40]] as [number, number][],
};

describe("host.document.snapPoint — v67 point snapping", () => {
  it("forwards the query verbatim and returns the engine's answer", async () => {
    const { host, fake } = makeHost();
    const answer: SnapPointResult = {
      point: [100, 100],
      snapped: true,
      pointTarget: {
        source: "corner",
        at: [100, 100],
        element: { kind: "rectangle", id: "r1" },
        anchorIndex: null,
      },
      lines: [],
      tolerancePt: 2,
    };
    fake.setSnapPointReply({ kind: "snapPoint", payload: { result: answer } });
    const r = await host.document.snapPoint(query as never);
    expect(fake.sent.at(-1)).toEqual({
      kind: "requestSnapPoint",
      payload: { query },
    });
    expect(r).toEqual(answer);
  });

  it("answers the point UNSNAPPED when the engine predates v67", async () => {
    const { host } = makeHost();
    const r = await host.document.snapPoint(query as never);
    expect(r).toEqual({
      point: [101, 99],
      snapped: false,
      lines: [],
      tolerancePt: 0,
    });
  });

  it("is a document READ, and says so", async () => {
    const { host } = makeHost({});
    await expect(host.document.snapPoint(query as never)).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    expect(makeHost().host.supports("document.snapPoint@1")).toBe(true);
  });
});

describe("host.document.snapPoint — against the real engine", () => {
  let live: HeadlessHost | null = null;
  afterEach(() => {
    live?.dispose();
    live = null;
  });

  it("lands a point near the page's corner on it", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    const r = await live.host.document.snapPoint({
      pageId,
      point: [2, 1],
      cameraScale: 1,
    });
    expect(r.snapped).toBe(true);
    expect(r.point).toEqual([0, 0]);
    expect(r.pointTarget?.source).toBe("page");
    expect(r.tolerancePt).toBe(4);
  });
});
