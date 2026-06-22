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

// D-11 (rfc-credential-store) — the host CREDENTIAL-STORE door
// (host.secrets) over a MOCK SecretStoreBackend (an in-memory ref set, no
// real keychain). Pins: the feature probe + capability gate, the
// set→exists→forget round-trip, the no-backend honest degradation, and —
// the trust-line keystone — that the surface has NO `get` (secret bytes
// never come back to the plugin realm; the HOST injects them at attach
// time).

import { describe, expect, it, vi } from "vitest";

import type { PagedEditor, PluginManifest } from "@paged-media/plugin-api";

import {
  createBundleHost,
  type SecretStoreBackend,
} from "../src/host-impl";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const MANIFEST = (declareSecrets: boolean): PluginManifest => ({
  id: "media.paged.d11",
  name: "d11",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: declareSecrets ? { secrets: { sources: true } } : {},
  contributes: {},
});

/** A mock SecretStoreBackend that records the (pluginId, ref) it HOLDS — and,
 *  to prove the trust line, retains the secret VALUE in a side table the
 *  TEST can inspect (the surface itself can never reach it; there is no
 *  read door). `set` records a "prompt shown" flag so a test can assert the
 *  "via host UI only" handoff happened. */
function makeMockSecretStore() {
  const held = new Map<string, string>(); // `${id}::${ref}` → secret (test-only)
  const promptsShown: Array<{ id: string; ref: string }> = [];
  const key = (id: string, ref: string) => `${id}::${ref}`;
  const backend: SecretStoreBackend = {
    async set(id, ref, secret) {
      promptsShown.push({ id, ref });
      held.set(key(id, ref), secret);
    },
    async exists(id, ref) {
      return held.has(key(id, ref));
    },
    async forget(id, ref) {
      held.delete(key(id, ref));
    },
  };
  return { backend, held, promptsShown, key };
}

function makeHost(declareSecrets: boolean, withBackend: boolean) {
  const mock = makeMockSecretStore();
  const handle = createBundleHost(
    () => ({}) as unknown as PagedEditor,
    MANIFEST(declareSecrets),
    {
      console: silent,
      storage: mapBacking(),
      capabilityMode: "enforce",
      ...(withBackend ? { secrets: mock.backend } : {}),
    },
  );
  return { ...handle, mock };
}

describe("host.secrets (D-11, mock backend)", () => {
  it("probes secrets@1 only when a backend is wired", () => {
    const wired = makeHost(true, true);
    expect(wired.host.supports("secrets@1")).toBe(true);
    const unwired = makeHost(true, false);
    expect(unwired.host.supports("secrets@1")).toBe(false);
  });

  it("set → exists → forget round-trips a credentialRef", async () => {
    const { host, mock } = makeHost(true, true);
    expect(await host.secrets.exists("keychain:source-4")).toBe(false);

    await host.secrets.set("keychain:source-4", "postgres://u:p@db.host/sales");
    expect(await host.secrets.exists("keychain:source-4")).toBe(true);
    // The set crossed to the backing under the plugin's namespace…
    expect(mock.promptsShown).toEqual([
      { id: "media.paged.d11", ref: "keychain:source-4" },
    ]);
    // …carrying the material the host will inject (test-only side table; the
    // SURFACE can never read it — see the no-get test below).
    expect(mock.held.get(mock.key("media.paged.d11", "keychain:source-4"))).toBe(
      "postgres://u:p@db.host/sales",
    );

    await host.secrets.forget("keychain:source-4");
    expect(await host.secrets.exists("keychain:source-4")).toBe(false);
  });

  it("THE TRUST LINE — the surface exposes NO `get` (secret bytes never return)", () => {
    const { host } = makeHost(true, true);
    // The keystone D-11 assertion: a plugin can set/exists/forget a ref but
    // can NEVER read the secret back. `get` must not exist on the surface in
    // any shape — its absence IS the contract.
    expect("get" in host.secrets).toBe(false);
    expect(
      (host.secrets as unknown as Record<string, unknown>).get,
    ).toBeUndefined();
    // The only members are the three reference-only doors.
    const members = Object.keys(host.secrets).sort();
    expect(members).toEqual(["exists", "forget", "set"]);
  });

  it("gates on capabilities.secrets (undeclared set/exists/forget reject)", async () => {
    const { host } = makeHost(false, true);
    await expect(
      host.secrets.set("keychain:x", "s"),
    ).rejects.toThrow(/capabilities\.secrets/);
    await expect(host.secrets.exists("keychain:x")).rejects.toThrow(
      /capabilities\.secrets/,
    );
    await expect(host.secrets.forget("keychain:x")).rejects.toThrow(
      /capabilities\.secrets/,
    );
  });

  it("no backend wired → set rejects honestly, exists is false, forget is a no-op", async () => {
    const { host } = makeHost(true, false);
    expect(host.supports("secrets@1")).toBe(false);
    await expect(
      host.secrets.set("keychain:x", "s"),
    ).rejects.toThrow(/no secret-store backend wired/);
    // exists answers the honest "nothing held" without a backend.
    expect(await host.secrets.exists("keychain:x")).toBe(false);
    // forget is a no-op (the gate already passed; nothing to remove).
    await expect(host.secrets.forget("keychain:x")).resolves.toBeUndefined();
  });

  it("namespaces refs per plugin id (the backing keys by manifest id)", async () => {
    const { host, mock } = makeHost(true, true);
    await host.secrets.set("source-1", "secret-A");
    expect(mock.held.has(mock.key("media.paged.d11", "source-1"))).toBe(true);
    // A different plugin id would key differently — the backing never
    // collides one bundle's ref with another's.
    expect(mock.held.has(mock.key("media.paged.other", "source-1"))).toBe(false);
  });
});

vi.restoreAllMocks();
