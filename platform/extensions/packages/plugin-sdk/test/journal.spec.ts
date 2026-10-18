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

// ADR 025 — `host.journal`, the local flight-recorder door, and the
// activation guard that finally made `loadBundle` survive a bad bundle.
//
// Coverage:
//   1. the door: entries reach the injected sink with the plugin id stamped
//      BY THE HOST, so attribution cannot be forged;
//   2. the namespace chokepoint: a code outside the manifest's namespace is
//      refused — and refused WITHOUT throwing into the plugin, because an
//      instrumentation door that breaks its subject is worse than none;
//   3. the inert posture: no backend means recording goes nowhere and
//      `supports("journal@1")` is false — never "calling this throws";
//   4. `time()` passes results and exceptions through unchanged;
//   5. THE ACTIVATION GUARD: a throwing bundle no longer takes the loader
//      down, is attributed in three places, and never leaks its message.

import { describe, expect, it, vi } from "vitest";

import type { PagedBundle, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, loadBundle, type JournalSink } from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function recordingSink() {
  const entries: { bundleId: string; entry: unknown }[] = [];
  const sink: JournalSink = {
    record: (bundleId, entry) => void entries.push({ bundleId, entry }),
  };
  return { sink, entries };
}

function makeHost(journal?: JournalSink, console = silent) {
  return createBundleHost(() => makeFakeEditor().editor, MANIFEST, {
    console,
    journal,
  });
}

describe("host.journal — the door", () => {
  it("stamps the plugin id itself, so attribution cannot be forged", () => {
    const { sink, entries } = recordingSink();
    const { host } = makeHost(sink);

    host.journal.record({ code: "media.paged.test.did.thing", data: { n: 1 } });

    expect(entries).toHaveLength(1);
    expect(entries[0].bundleId).toBe("media.paged.test");
    // The bundle supplied no id of its own — there is nowhere on the record
    // type to put one.
    expect(entries[0].entry).toMatchObject({
      code: "media.paged.test.did.thing",
      data: { n: 1 },
    });
  });

  it("refuses a code outside the manifest namespace, without throwing", () => {
    const { sink, entries } = recordingSink();
    const warn = vi.fn();
    const { host } = makeHost(sink, { ...silent, warn });

    expect(() =>
      host.journal.record({ code: "media.paged.other.sneaky" }),
    ).not.toThrow();

    expect(entries).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("journal.record refused");
  });

  it("is inert without a backend, and says so through supports()", () => {
    const { host } = makeHost(undefined);
    expect(host.supports("journal@1")).toBe(false);
    // Inert means INERT — not throwing. A plugin that instruments itself must
    // keep working on a host that keeps no ring.
    expect(() => host.journal.record({ code: "media.paged.test.x" })).not.toThrow();
  });

  it("reports journal@1 only when a real ring is wired", () => {
    const { sink } = recordingSink();
    expect(makeHost(sink).host.supports("journal@1")).toBe(true);
  });
});

describe("host.journal.time", () => {
  it("returns the thunk's value and records ok", async () => {
    const { sink, entries } = recordingSink();
    const { host } = makeHost(sink);

    const out = await host.journal.time("media.paged.test.work", () => 42);

    expect(out).toBe(42);
    expect(entries[0].entry).toMatchObject({ data: { ok: true } });
    expect(
      (entries[0].entry as { durMs?: number }).durMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("rethrows unchanged and records the failure", async () => {
    const { sink, entries } = recordingSink();
    const { host } = makeHost(sink);
    const boom = new Error("boom");

    await expect(
      host.journal.time("media.paged.test.work", () => {
        throw boom;
      }),
    ).rejects.toBe(boom); // the SAME error object, not a wrapper

    expect(entries[0].entry).toMatchObject({
      severity: "error",
      data: { ok: false },
    });
  });
});

describe("loadBundle — the activation guard", () => {
  const goodBundle = (id: string): PagedBundle => ({
    manifest: { ...MANIFEST, id },
    activate: () => ({ dispose() {} }),
  });
  const badBundle = (id: string): PagedBundle => ({
    manifest: { ...MANIFEST, id },
    activate: () => {
      throw new TypeError(
        `Cannot read properties of undefined at /Users/alice/plugins/${id}.js`,
      );
    },
  });

  it("does not throw, so the bundles after it still load", () => {
    const { sink } = recordingSink();
    const editor = makeFakeEditor().editor;
    const opts = { console: silent, journal: sink };

    const loaded = [
      loadBundle(() => editor, goodBundle("media.paged.a"), opts),
      loadBundle(() => editor, badBundle("media.paged.b"), opts),
      loadBundle(() => editor, goodBundle("media.paged.c"), opts),
    ];

    expect(loaded.map((l) => l.active)).toEqual([true, false, true]);
    expect(loaded[1].activationError).toBeInstanceOf(TypeError);
  });

  it("attributes the failure in the journal and the problems sink", () => {
    const { sink, entries } = recordingSink();
    const publish = vi.fn();
    loadBundle(() => makeFakeEditor().editor, badBundle("media.paged.b"), {
      console: silent,
      journal: sink,
      diagnosticsSink: { publish, clear() {} },
    });

    const failure = entries.find(
      (e) => (e.entry as { data?: { ok?: boolean } }).data?.ok === false,
    );
    expect(failure?.bundleId).toBe("media.paged.b");
    expect(failure?.entry).toMatchObject({
      severity: "error",
      data: { error: "typeerror" },
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][1]).toBe("activation");
  });

  it("never carries the throw's text into the journal", () => {
    const { sink, entries } = recordingSink();
    loadBundle(() => makeFakeEditor().editor, badBundle("media.paged.b"), {
      console: silent,
      journal: sink,
    });
    // A real activation throw carries a module path; only the KIND may cross.
    const json = JSON.stringify(entries);
    expect(json).not.toContain("/Users/alice");
    expect(json).not.toContain("Cannot read properties");
    expect(json).toContain("typeerror");
  });

  it("a failed bundle's dispose is a genuine no-op, not a lying teardown", () => {
    const loaded = loadBundle(
      () => makeFakeEditor().editor,
      badBundle("media.paged.b"),
      { console: silent },
    );
    expect(() => loaded.dispose()).not.toThrow();
    expect(loaded.active).toBe(false);
  });

  it("records a successful activation too, so the roster is complete", () => {
    const { sink, entries } = recordingSink();
    loadBundle(() => makeFakeEditor().editor, goodBundle("media.paged.a"), {
      console: silent,
      journal: sink,
    });
    expect(entries[0].entry).toMatchObject({ data: { ok: true } });
  });
});
