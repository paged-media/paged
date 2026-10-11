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

// ADR 326 — the MODULE door (host.modules) over a scripted ModulesBackend,
// and the bundle-side helpers (resolveWasm / fetchWasm) that fall back to
// the bundle-relative URL on a host without it. Pins: declared-only (the
// backend sees the manifest's artifact, an undeclared name is refused),
// the feature probe, integrity passthrough (manifest stamp wins, a
// contradicting host digest is refused), and the fallback paths.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginManifest, WasmArtifact } from "@paged-media/plugin-api";

import {
  createBundleHost,
  fetchWasm,
  resolveWasm,
  resolveWasmUrl,
  type ModulesBackend,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const SRI_A = "sha384-" + "A".repeat(64);
const SRI_B = "sha384-" + "B".repeat(64);

const manifest = (wasm: WasmArtifact[]): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { wasm },
});

const ENGINE: WasmArtifact = { name: "engine", path: "bin/engine.wasm", purpose: "compute" };

function hostWith(
  wasm: WasmArtifact[],
  backend?: ModulesBackend,
  capabilityMode: "enforce" | "warn" = "enforce",
) {
  const fake = makeFakeEditor();
  return createBundleHost(() => fake.editor, manifest(wasm), {
    console: silent,
    capabilityMode,
    ...(backend ? { modules: backend } : {}),
  }).host;
}

function recordingBackend(
  answer: (pluginId: string, a: WasmArtifact) => { url: string; integrity?: string | null } | null,
) {
  const calls: Array<[string, WasmArtifact]> = [];
  const backend: ModulesBackend = {
    url(pluginId, artifact) {
      calls.push([pluginId, artifact]);
      return answer(pluginId, artifact);
    },
  };
  return { backend, calls };
}

const hosted = (_: string, a: WasmArtifact) => ({
  url: `https://modules.paged.media/@paged-media/test/1.0.0/${a.path}`,
  integrity: SRI_A,
});

afterEach(() => vi.unstubAllGlobals());

describe("host.modules", () => {
  it("resolves a declared artifact through the backend", async () => {
    const { backend, calls } = recordingBackend(hosted);
    const host = hostWith([ENGINE], backend);
    expect(host.supports("modules@1")).toBe(true);
    const r = await host.modules.resolve("engine");
    expect(r).toEqual({
      url: "https://modules.paged.media/@paged-media/test/1.0.0/bin/engine.wasm",
      integrity: SRI_A,
      artifact: ENGINE,
    });
    expect(await host.modules.url("engine")).toBe(r!.url);
    // The backend is handed the MANIFEST's artifact for the bundle's id.
    expect(calls[0]).toEqual(["media.paged.test", ENGINE]);
  });

  it("refuses an undeclared name before the backend is asked", async () => {
    const { backend, calls } = recordingBackend(hosted);
    const host = hostWith([ENGINE], backend);
    await expect(host.modules.resolve("other")).rejects.toThrow(/capabilities\.wasm/);
    await expect(host.modules.fetch("other")).rejects.toThrow(/capabilities\.wasm/);
    expect(calls).toHaveLength(0);
    // 'warn' proceeds — but there is no declared path to hand the backend.
    const lax = hostWith([ENGINE], backend, "warn");
    expect(await lax.modules.resolve("other")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("answers null without a backend, and supports() says so", async () => {
    const host = hostWith([ENGINE]);
    expect(host.supports("modules@1")).toBe(false);
    expect(await host.modules.resolve("engine")).toBeNull();
    expect(await host.modules.url("engine")).toBeNull();
    expect(await host.modules.fetch("engine")).toBeNull();
  });

  it("answers null when the backend does not serve it, throws, or answers garbage", async () => {
    expect(await hostWith([ENGINE], { url: () => null }).modules.resolve("engine")).toBeNull();
    const throwing: ModulesBackend = {
      url() {
        throw new Error("boom");
      },
    };
    expect(await hostWith([ENGINE], throwing).modules.resolve("engine")).toBeNull();
    const relative: ModulesBackend = { url: () => ({ url: "bin/engine.wasm" }) };
    expect(await hostWith([ENGINE], relative).modules.resolve("engine")).toBeNull();
  });

  it("passes the manifest's integrity stamp, which wins over the host's", async () => {
    const stamped = { ...ENGINE, integrity: SRI_A };
    const noHostSri = hostWith([stamped], { url: () => ({ url: "https://m.example/x.wasm" }) });
    expect((await noHostSri.modules.resolve("engine"))?.integrity).toBe(SRI_A);
    const otherAlg = hostWith([stamped], {
      url: () => ({ url: "https://m.example/x.wasm", integrity: "sha256-" + "C".repeat(43) + "=" }),
    });
    expect((await otherAlg.modules.resolve("engine"))?.integrity).toBe(SRI_A);
  });

  it("refuses a host answer whose digest contradicts the manifest", async () => {
    const stamped = { ...ENGINE, integrity: SRI_A };
    const host = hostWith([stamped], { url: () => ({ url: "https://m.example/x.wasm", integrity: SRI_B }) });
    expect(await host.modules.resolve("engine")).toBeNull();
  });

  it("fetches with { integrity } when one is known", async () => {
    const fetchMock = vi.fn(async () => new Response("wasm"));
    vi.stubGlobal("fetch", fetchMock);
    const host = hostWith([ENGINE], recordingBackend(hosted).backend);
    const res = await host.modules.fetch("engine");
    expect(await res!.text()).toBe("wasm");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://modules.paged.media/@paged-media/test/1.0.0/bin/engine.wasm",
      { integrity: SRI_A },
    );
    const plain = hostWith([ENGINE], { url: () => ({ url: "https://m.example/x.wasm" }) });
    await plain.modules.fetch("engine");
    expect(fetchMock).toHaveBeenLastCalledWith("https://m.example/x.wasm");
  });
});

describe("resolveWasm / fetchWasm (bundle side)", () => {
  const FALLBACK = "https://editor.example/assets/engine-abc.wasm";

  it("takes the host's answer when the door is wired", async () => {
    const host = hostWith([ENGINE], recordingBackend(hosted).backend);
    expect(await resolveWasm(host, "engine", FALLBACK)).toEqual({
      url: "https://modules.paged.media/@paged-media/test/1.0.0/bin/engine.wasm",
      integrity: SRI_A,
      source: "host",
    });
  });

  it("falls back to the bundle URL (with the manifest stamp) on a host without a backend", async () => {
    const host = hostWith([{ ...ENGINE, integrity: SRI_B }]);
    expect(await resolveWasm(host, "engine", new URL(FALLBACK))).toEqual({
      url: FALLBACK,
      integrity: SRI_B,
      source: "bundle",
    });
  });

  it("falls back on a host that predates the door (no host.modules at all)", async () => {
    const old = {
      manifest: manifest([ENGINE]),
      supports: () => false,
    };
    expect(await resolveWasmUrl(old, "engine", FALLBACK)).toBe(FALLBACK);
    // A host that claims the flag but lacks the member still falls back.
    expect(await resolveWasmUrl({ ...old, supports: () => true }, "engine", FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the host refuses or does not serve the name", async () => {
    const host = hostWith([ENGINE], { url: () => null });
    expect(await resolveWasmUrl(host, "engine", FALLBACK)).toBe(FALLBACK);
    // An undeclared name rejects at the door; the helper never does.
    expect(await resolveWasmUrl(host, "other", FALLBACK)).toBe(FALLBACK);
  });

  it("fetchWasm fetches the resolved URL with its integrity", async () => {
    const fetchMock = vi.fn(async () => new Response("wasm"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWasm(hostWith([{ ...ENGINE, integrity: SRI_B }]), "engine", FALLBACK);
    expect(fetchMock).toHaveBeenLastCalledWith(FALLBACK, { integrity: SRI_B });
    await fetchWasm(hostWith([ENGINE]), "engine", FALLBACK);
    expect(fetchMock).toHaveBeenLastCalledWith(FALLBACK);
  });
});
