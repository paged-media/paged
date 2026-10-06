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

// W-15 — `host.assets.registerFont`, the one WRITE on the asset door: a
// bundle hands the engine a face that only SCENE-LAYER text resolves
// (never document layout, the Fonts panel's missing flag or preflight).
// Coverage: forwarding to the host's provider; the gate; the per-face
// budget; an older host (inert, flag false); disposal clears the scene
// table and replays every other live face — across bundles sharing one
// provider — and a bundle's teardown takes its faces with it.

import { describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import {
  ASSET_BUDGETS,
  createBundleHost,
  PluginCapabilityError,
  type BundleAssetProvider,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  id = "media.paged.test",
  capabilities: PluginManifest["capabilities"] = { assets: ["fonts"] },
): PluginManifest => ({
  id,
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

type Call =
  | { op: "register"; family: string; style?: string; size: number }
  | { op: "clear" };

/** A provider that records the engine calls the SDK makes on it. */
function recordingProvider(): BundleAssetProvider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async getFontFace() {
      return null;
    },
    async registerFont(family, bytes, style) {
      calls.push(
        style === undefined
          ? { op: "register", family, size: bytes.byteLength }
          : { op: "register", family, style, size: bytes.byteLength },
      );
    },
    async clearSceneFonts() {
      calls.push({ op: "clear" });
    },
  };
}

function hostOver(
  assetSource: BundleAssetProvider | undefined,
  id?: string,
  caps?: PluginManifest["capabilities"],
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest(id, caps), {
    console: silent,
    capabilityMode: "enforce",
    assetSource,
  });
}

const face = (n = 16) => new Uint8Array(n).fill(1);
/** Let the SDK's serialized register/clear chain drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("host.assets.registerFont (W-15)", () => {
  it("forwards the face to the host's provider and resolves a Disposable", async () => {
    const p = recordingProvider();
    const { host } = hostOver(p);
    expect(host.supports("assets.registerFont@1")).toBe(true);
    const d = await host.assets.registerFont(face(20), "Inter", "Bold");
    expect(typeof d.dispose).toBe("function");
    expect(p.calls).toEqual([
      { op: "register", family: "Inter", style: "Bold", size: 20 },
    ]);
  });

  it("is gated on capabilities.assets including fonts", async () => {
    const p = recordingProvider();
    const { host } = hostOver(p, undefined, {});
    await expect(host.assets.registerFont(face(), "Inter")).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    expect(p.calls).toEqual([]);
  });

  it("refuses a face over the per-face budget", async () => {
    const p = recordingProvider();
    const { host } = hostOver(p);
    await expect(
      host.assets.registerFont(face(ASSET_BUDGETS.maxFontFaceBytes + 1), "Huge"),
    ).rejects.toThrow(/cap/);
    expect(p.calls).toEqual([]);
  });

  it("is inert on a host whose provider cannot register (flag false)", async () => {
    const warns: string[] = [];
    const readOnly: BundleAssetProvider = { getFontFace: async () => null };
    const { host } = createBundleHost(() => makeFakeEditor().editor, manifest(), {
      console: { ...silent, warn: (m: string) => void warns.push(m) },
      capabilityMode: "enforce",
      assetSource: readOnly,
    });
    expect(host.supports("assets.registerFont@1")).toBe(false);
    const d = await host.assets.registerFont(face(), "Inter");
    d.dispose();
    expect(warns.some((w) => w.includes("assets.registerFont"))).toBe(true);
    // No provider at all: same.
    expect(hostOver(undefined).host.supports("assets.registerFont@1")).toBe(false);
  });

  it("dispose clears the scene faces and replays every other live face, across bundles", async () => {
    const p = recordingProvider();
    const a = hostOver(p, "media.paged.a").host;
    const b = hostOver(p, "media.paged.b").host;
    const a1 = await a.assets.registerFont(face(1), "Inter");
    await b.assets.registerFont(face(2), "Lora", "Italic");
    const a2 = await a.assets.registerFont(face(3), "Inter", "Bold");
    p.calls.length = 0;

    a1.dispose();
    await settle();
    expect(p.calls).toEqual([
      { op: "clear" },
      { op: "register", family: "Lora", style: "Italic", size: 2 },
      { op: "register", family: "Inter", style: "Bold", size: 3 },
    ]);

    p.calls.length = 0;
    a1.dispose(); // idempotent
    a2.dispose();
    await settle();
    expect(p.calls).toEqual([
      { op: "clear" },
      { op: "register", family: "Lora", style: "Italic", size: 2 },
    ]);
  });

  it("a bundle's teardown takes its faces with it", async () => {
    const p = recordingProvider();
    const a = hostOver(p, "media.paged.a");
    const b = hostOver(p, "media.paged.b");
    await a.host.assets.registerFont(face(1), "Inter");
    await b.host.assets.registerFont(face(2), "Lora");
    p.calls.length = 0;
    a.dispose();
    await settle();
    expect(p.calls).toEqual([
      { op: "clear" },
      { op: "register", family: "Lora", size: 2 },
    ]);
    p.calls.length = 0;
    b.dispose();
    await settle();
    expect(p.calls).toEqual([{ op: "clear" }]);
  });
});
