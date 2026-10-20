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

// D-03 — the capability-gated NETWORK CONSENT door (`host.network`).
//
// Coverage:
//   1. the gate: requestConsent on a manifest WITHOUT capabilities.network is
//      refused (throws PluginCapabilityError in 'enforce');
//   2. the door: a declared origin + a granting backend → granted, and
//      consentedOrigins() reflects it;
//   3. the allow-list: an origin outside capabilities.network is denied even if
//      the backend would grant it (the OUTER bound);
//   4. no backend wired → every origin denied + supports("network.consent@1")
//      is false (the honest no-consent posture);
//   5. the grants are the host's (editor ADR 264): a backend that keeps them
//      (`grants`) is asked what the plugin holds for the open document; the
//      SDK writes nothing to the bundle's storage, and a backend that keeps
//      none gets session grants only — never a remembered one.

import { describe, expect, it } from "bun:test";

import type { ConsentResult, PluginManifest } from "@paged-media/plugin-api";

import {
  createBundleHost,
  PluginCapabilityError,
  type ConsentBackend,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

import { mapBacking, silentConsole as silent } from "../src/testing";
const API = "https://api.test";
const EVIL = "https://evil.test";

const DECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { network: { origins: [API], purpose: "bind to a dataset" } },
};
const UNDECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

/** A consent backend that grants exactly `grant`, optionally remembered. */
function grantBackend(grant: string[], remembered = false): ConsentBackend {
  return {
    async request(origins): Promise<ConsentResult> {
      return {
        granted: origins.filter((o) => grant.includes(o)),
        denied: origins.filter((o) => !grant.includes(o)),
        remembered,
      };
    },
  };
}

function makeHost(
  manifest: PluginManifest,
  consent?: ConsentBackend,
  storage = mapBacking(),
  capabilityMode: "enforce" | "warn" = "enforce",
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console: silent,
    storage,
    capabilityMode,
    consent,
  });
}

describe("host.network — consent door (D-03)", () => {
  it("refuses requestConsent when capabilities.network is undeclared (enforce)", async () => {
    const { host } = makeHost(UNDECLARED, grantBackend([API]));
    await expect(
      host.network.requestConsent([API], "x"),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
  });

  it("grants a declared origin; consentedOrigins reflects it", async () => {
    const { host } = makeHost(DECLARED, grantBackend([API]));
    const r = await host.network.requestConsent([API], "bind");
    expect(r.granted).toEqual([API]);
    expect(r.denied).toEqual([]);
    expect(host.network.consentedOrigins()).toContain(API);
  });

  it("denies an origin outside the declared allow-list, even if the backend would grant", async () => {
    const { host } = makeHost(DECLARED, grantBackend([API, EVIL]));
    const r = await host.network.requestConsent([EVIL], "bind");
    expect(r.granted).toEqual([]);
    expect(r.denied).toContain(EVIL);
    expect(host.network.consentedOrigins()).not.toContain(EVIL);
  });

  it("denies everything + supports() is false when no consent backend is wired", async () => {
    const { host } = makeHost(DECLARED);
    expect(host.supports("network.consent@1")).toBe(false);
    const r = await host.network.requestConsent([API], "bind");
    expect(r.granted).toEqual([]);
    expect(r.denied).toContain(API);
  });

  it("supports('network.consent@1') is true when a backend is wired", () => {
    const { host } = makeHost(DECLARED, grantBackend([]));
    expect(host.supports("network.consent@1")).toBe(true);
  });

  it("without a backend that keeps grants: session grants only, nothing remembered or stored", async () => {
    const storage = mapBacking();
    const a = makeHost(DECLARED, grantBackend([API], true), storage);
    const r = await a.host.network.requestConsent([API], "bind");
    expect(r).toEqual({ granted: [API], denied: [], remembered: false });
    expect(a.host.network.consentedOrigins()).toEqual([API]);
    // A fresh host over the same storage holds nothing: no grant was
    // written where another document's host would find it.
    const b = makeHost(DECLARED, grantBackend([]), storage);
    expect(b.host.network.consentedOrigins()).toEqual([]);
    expect(storage.keys().filter((k) => k.includes("consent"))).toEqual([]);
  });

  it("a grant stored the old way (the bundle's storage) is ignored and cleared", () => {
    const storage = mapBacking();
    storage.setItem(
      "paged.plugin.media.paged.test.network.consentedOrigins",
      JSON.stringify([API]),
    );
    const { host } = makeHost(DECLARED, grantBackend([]), storage);
    expect(host.network.consentedOrigins()).toEqual([]);
    expect(storage.keys()).toEqual([]);
  });

  it("a backend that keeps the grants is asked what the plugin holds, per plugin", async () => {
    const held = new Map<string, string[]>();
    const asked: { origins: readonly string[]; plugin?: string }[] = [];
    const backend: ConsentBackend = {
      grants: (plugin) => held.get(plugin) ?? [],
      async request(origins, _purpose, plugin) {
        asked.push({ origins, plugin });
        held.set(plugin!, [...(held.get(plugin!) ?? []), ...origins]);
        return { granted: [...origins], denied: [], remembered: true };
      },
    };
    const { host } = makeHost(DECLARED, backend);
    expect(host.network.consentedOrigins()).toEqual([]);
    const r = await host.network.requestConsent([API], "bind");
    expect(r).toEqual({ granted: [API], denied: [], remembered: true });
    expect(asked).toEqual([{ origins: [API], plugin: "media.paged.test" }]);
    // Held: not asked again.
    await host.network.requestConsent([API], "again");
    expect(asked).toHaveLength(1);
    // The host changed its mind (another document is open): asked again.
    held.clear();
    expect(host.network.consentedOrigins()).toEqual([]);
    await host.network.requestConsent([API], "the next document");
    expect(asked).toHaveLength(2);
  });
});
