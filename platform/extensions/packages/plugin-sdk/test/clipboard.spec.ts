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

// K-6 / S-14 — the capability-gated SYSTEM-clipboard door (`host.clipboard`).
//
// Coverage:
//   1. the door: write/read round-trip a `{ text, tabular }` payload through
//      the injected backend (the "full" grant — text + tabular);
//   2. the tiers: a "vector" grant gets text ONLY — a tabular write is
//      stripped, a tabular read never surfaces the grid;
//   3. the gate: a manifest WITHOUT `capabilities.clipboard` is refused —
//      throw in 'enforce', warn+proceed in 'warn' (the warn path is text-only);
//   4. the no-backend door: no backend → read null, write no-op (the honest
//      no-clipboard posture); supports("clipboard@1") is false.

import { describe, expect, it } from "vitest";

import type { ClipboardPayload, PluginManifest } from "@paged-media/plugin-api";

import {
  createBundleHost,
  PluginCapabilityError,
  type ClipboardBackend,
} from "../src";
import { inMemoryClipboard } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const FULL: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { clipboard: "full" },
};
const VECTOR: PluginManifest = {
  ...FULL,
  capabilities: { clipboard: "vector" },
};
const NONE: PluginManifest = {
  ...FULL,
  capabilities: { clipboard: "none" },
};
const UNDECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function makeHost(
  manifest: PluginManifest,
  clipboard?: ClipboardBackend,
  capabilityMode: "enforce" | "warn" = "enforce",
  console = silent,
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console,
    capabilityMode,
    clipboard,
  });
}

const grid = (rows: string[][]): ClipboardPayload => ({
  text: rows.map((r) => r.join("\t")).join("\n"),
  tabular: { rows },
});

describe("host.clipboard — the door (K-6)", () => {
  it("round-trips a text + tabular payload through the injected backend", async () => {
    const { host } = makeHost(FULL, inMemoryClipboard());
    expect(await host.clipboard.read()).toBeNull();

    const payload = grid([
      ["Name", "Qty"],
      ["Apples", "12"],
    ]);
    await host.clipboard.write(payload);

    const back = await host.clipboard.read();
    expect(back?.text).toBe("Name\tQty\nApples\t12");
    expect(back?.tabular?.rows).toEqual([
      ["Name", "Qty"],
      ["Apples", "12"],
    ]);
  });

  it("supports('clipboard@1') tracks whether a backend is wired", () => {
    expect(makeHost(FULL).host.supports("clipboard@1")).toBe(false);
    expect(
      makeHost(FULL, inMemoryClipboard()).host.supports("clipboard@1"),
    ).toBe(true);
  });
});

describe("host.clipboard — the tiers (K-6)", () => {
  it('"vector" strips a tabular write to text only', async () => {
    const backend = inMemoryClipboard();
    const { host } = makeHost(VECTOR, backend);
    await host.clipboard.write(grid([["a", "b"]]));
    // The backend stored text but no tabular (the surface stripped it).
    const stored = await backend.read();
    expect(stored?.text).toBe("a\tb");
    expect(stored?.tabular).toBeUndefined();
  });

  it('"vector" never surfaces the tabular half on read', async () => {
    const backend = inMemoryClipboard();
    // A FULL producer puts a grid on the clipboard…
    await backend.write(grid([["x", "y"]]));
    // …but a VECTOR consumer reading it only sees the text.
    const { host } = makeHost(VECTOR, backend);
    const back = await host.clipboard.read();
    expect(back?.text).toBe("x\ty");
    expect(back?.tabular).toBeUndefined();
  });
});

describe("host.clipboard — the gate (K-6)", () => {
  it("throws in enforce mode when clipboard is not declared", async () => {
    const { host } = makeHost(UNDECLARED, inMemoryClipboard(), "enforce");
    await expect(host.clipboard.write(grid([["a"]]))).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    await expect(host.clipboard.read()).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });

  it('"none" is denied like an absent declaration', async () => {
    const { host } = makeHost(NONE, inMemoryClipboard(), "enforce");
    await expect(host.clipboard.read()).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });

  it("warns + proceeds (text only) in warn mode when undeclared", async () => {
    let warned = 0;
    const backend = inMemoryClipboard();
    const { host } = makeHost(UNDECLARED, backend, "warn", {
      ...silent,
      warn: () => void (warned += 1),
    });
    // The proceed treats the undeclared grant as the narrower "vector"
    // tier — a tabular write never leaks the grid even in warn mode.
    await host.clipboard.write(grid([["a", "b"]]));
    expect(warned).toBeGreaterThan(0);
    const stored = await backend.read();
    expect(stored?.text).toBe("a\tb");
    expect(stored?.tabular).toBeUndefined();
  });
});

describe("host.clipboard — the no-backend door (K-6)", () => {
  it("read null + write no-op when no backend is wired", async () => {
    const { host } = makeHost(FULL); // no clipboard injected
    expect(host.supports("clipboard@1")).toBe(false);
    expect(await host.clipboard.read()).toBeNull();
    // A write is a no-op (resolves, never throws) — the honest no-clipboard
    // door, distinct from the gate (which still fires for an undeclared cap).
    await expect(host.clipboard.write(grid([["a"]]))).resolves.toBeUndefined();
  });

  it("a throwing/denied backend read answers null (not a throw)", async () => {
    const denying: ClipboardBackend = {
      async read() {
        throw new Error("NotAllowedError: clipboard read requires a gesture");
      },
      async write() {},
    };
    const { host } = makeHost(FULL, denying);
    expect(await host.clipboard.read()).toBeNull();
  });

  it("a platform write refusal is swallowed (logged, not thrown)", async () => {
    let warned = 0;
    const refusing: ClipboardBackend = {
      async read() {
        return null;
      },
      async write() {
        throw new Error("NotAllowedError");
      },
    };
    const { host } = makeHost(FULL, refusing, "enforce", {
      ...silent,
      warn: () => void (warned += 1),
    });
    await expect(
      host.clipboard.write(grid([["a"]])),
    ).resolves.toBeUndefined();
    expect(warned).toBeGreaterThan(0);
  });
});
