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
//   5. remember: a remembered grant persists across hosts via storage.

import { describe, expect, it } from "vitest";

import type { ConsentResult, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError, type ConsentBackend } from "../src";
import { makeFakeEditor } from "./fake-editor";

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
    await expect(host.network.requestConsent([API], "x")).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
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

  it("a remembered grant persists across hosts via storage", async () => {
    const storage = mapBacking();
    const a = makeHost(DECLARED, grantBackend([API], true), storage);
    await a.host.network.requestConsent([API], "bind");
    // A fresh host (no backend) over the same storage still sees the grant.
    const b = makeHost(DECLARED, undefined, storage);
    expect(b.host.network.consentedOrigins()).toContain(API);
  });
});
