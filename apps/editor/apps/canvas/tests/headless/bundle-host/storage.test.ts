/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// THE BUNDLEHOST CONTRACT — the persistence doors: `host.storage` (KV),
// `host.blob` (binary, per browser), `host.clipboard`, `host.secrets`.
// Each case asserts what plugin-api's host.ts / clipboard.ts documents, on
// every adapter it applies to (hosts.ts). A case that holds on one adapter
// and not another is a finding, recorded as an expected failure on the
// adapter that diverges.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  OTHER_ID,
  PROBE_ID,
  editorAdapter,
  bareAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

const bytes = (...xs: number[]) => new Uint8Array(xs);

// ── host.storage ─────────────────────────────────────────────────────

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.storage — %s", (name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("set/get round-trips a JSON value; a missing key reads undefined", () => {
    const s = t.host.storage;
    const value = { a: 1, b: [true, null, "x"], c: { d: 2.5 } };
    s.set("recipe", value);
    expect(s.get("recipe")).toEqual(value);
    expect(s.get("never-set")).toBeUndefined();
  });

  test("keys() lists this plugin's keys only; delete removes one", () => {
    const s = t.host.storage;
    const sibling = t.sibling();
    s.set("k1", 1);
    s.set("k2", 2);
    sibling.storage.set("theirs", 3);
    expect(s.keys()).toEqual(expect.arrayContaining(["k1", "k2"]));
    expect(s.keys()).not.toContain("theirs");
    expect(sibling.storage.get("k1")).toBeUndefined();
    s.delete("k1");
    expect(s.get("k1")).toBeUndefined();
    expect(s.keys()).not.toContain("k1");
    expect(sibling.storage.get("theirs")).toBe(3);
  });

  // "Namespaced key-value PERSISTENCE": what a bundle stored is there when
  // the same bundle is activated again on the same host (a reload, a
  // re-activation after an error). The editor's backing is localStorage;
  // the headless harness gives every host a fresh in-memory map when no
  // `storage` is injected, while it shares its blob store across hosts "so
  // a reloaded bundle sees its own persisted bytes".
  const persists = name === "headless" ? test.failing : test;
  if (name !== "bare")
    persists(
      name === "headless"
        ? "HOST-1 — a re-activated bundle reads what it stored (headless: a fresh map per host)"
        : "a re-activated bundle reads what it stored",
      () => {
        t.host.storage.set("persisted", { v: 7 });
        const again = t.reactivate();
        expect(again.storage.get("persisted")).toEqual({ v: 7 });
      },
    );
});

// ── host.blob ────────────────────────────────────────────────────────

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const)("host.blob, a store wired — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("supports storage.blob@1", () => {
    expect(t.host.supports("storage.blob@1")).toBe(true);
  });

  test("write/read round-trips the bytes, as a copy of what was written", async () => {
    const b = t.host.blob;
    const input = bytes(1, 2, 3, 4);
    await b.write("workbook", input);
    input[0] = 99;
    expect(Array.from((await b.read("workbook"))!)).toEqual([1, 2, 3, 4]);
    expect(await b.read("absent")).toBeNull();
  });

  test("keys() lists, delete() removes, a key with a slash or non-ASCII survives", async () => {
    const b = t.host.blob;
    await b.write("a/b", bytes(1));
    await b.write("größe", bytes(2));
    expect(await b.keys()).toEqual(expect.arrayContaining(["a/b", "größe"]));
    await b.delete("a/b");
    expect(await b.read("a/b")).toBeNull();
    expect(await b.keys()).not.toContain("a/b");
    expect(Array.from((await b.read("größe"))!)).toEqual([2]);
    // Deleting what is not there is not an error.
    await b.delete("a/b");
  });

  test("usage(): used is what is stored now, quota the stricter of the host cap and the manifest's", async () => {
    const b = t.host.blob;
    for (const k of await b.keys()) await b.delete(k);
    await b.write("x", new Uint8Array(1000));
    await b.write("x", new Uint8Array(400)); // an overwrite replaces
    await b.write("y", new Uint8Array(100));
    expect(await b.usage()).toEqual({ used: 500, quota: 64 * 1024 });
  });

  test("a write past the quota rejects and stores nothing", async () => {
    const b = t.host.blob;
    await expect(b.write("big", new Uint8Array(64 * 1024 + 1))).rejects.toThrow(
      /quota/,
    );
    expect(await b.read("big")).toBeNull();
  });

  test("another plugin's bytes are invisible", async () => {
    await t.host.blob.write("mine", bytes(5));
    const sibling = t.sibling();
    expect(await sibling.blob.read("mine")).toBeNull();
    expect(await sibling.blob.keys()).not.toContain("mine");
  });

  test("an undeclared blob store is a capability error", async () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenoblob", {
        capabilities: { storage: {} },
      }),
    );
    await expect(narrow.blob.write("k", bytes(1))).rejects.toThrow(
      /capabilities\.storage/,
    );
  });
});

describe("host.blob, no store wired — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("read null, keys [], usage {0, 0}, write rejects, supports false", async () => {
    const b = t.host.blob;
    expect(t.host.supports("storage.blob@1")).toBe(false);
    expect(await b.read("k")).toBeNull();
    expect(await b.keys()).toEqual([]);
    expect(await b.usage()).toEqual({ used: 0, quota: 0 });
    await expect(b.write("k", bytes(1))).rejects.toThrow(/no blob store/);
  });
});

describe("host.blob — the editor's OPFS backing", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("bytes land under plugin-blobs/<plugin id>/, the key encoded into one file name", async () => {
    await t.host.blob.write("a/b c", bytes(1, 2));
    expect(t.editorApp!.platform.opfs.files(PROBE_ID)).toContain(
      encodeURIComponent("a/b c"),
    );
  });

  // `supports("storage.blob@1")` means "a real store is wired, so a bundle
  // can actually persist bytes" (host-impl.ts). The editor answers true
  // whenever it injected its OPFS backend, also where OPFS is unavailable
  // (an insecure context, a denied origin): every write then rejects.
  test.failing(
    "HOST-2 — with OPFS unavailable, supports(storage.blob@1) still says bytes persist",
    async () => {
      t.editorApp!.platform.opfs.setAvailable(false);
      try {
        let persisted = true;
        try {
          await t.host.blob.write("k", bytes(1));
        } catch {
          persisted = false;
        }
        expect(t.host.supports("storage.blob@1")).toBe(persisted);
      } finally {
        t.editorApp!.platform.opfs.setAvailable(true);
      }
    },
  );
});

// ── host.clipboard ───────────────────────────────────────────────────

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const)("host.clipboard, a backend wired — %s", (name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("supports clipboard@1", () => {
    expect(t.host.supports("clipboard@1")).toBe(true);
  });

  test("a text copy reads back its text", async () => {
    await t.host.clipboard.write({ text: "hello" });
    expect((await t.host.clipboard.read())?.text).toBe("hello");
  });

  // clipboard.ts: "a grid copy carries BOTH (the tabular grid AND a TSV
  // text fallback so a paste into a plain editor still lands something)".
  // The editor writes the TSV for a grid copy that brought none; the
  // headless in-memory clipboard hands back exactly what was written.
  const both = name === "headless" ? test.failing : test;
  both(
    name === "headless"
      ? "HOST-3 — a grid copy reads back the grid AND its TSV text (headless: no text half)"
      : "a grid copy reads back the grid AND its TSV text",
    async () => {
      await t.host.clipboard.write({
        tabular: {
          rows: [
            ["a", "b"],
            ["1", "2"],
          ],
        },
      });
      const got = await t.host.clipboard.read();
      expect(got?.tabular?.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
      ]);
      expect(got?.text).toBe("a\tb\n1\t2");
    },
  );

  test('a "vector" grant writes and reads text only', async () => {
    const vector = t.withManifest(
      probeManifest("media.paged.probevector", {
        capabilities: { clipboard: "vector" },
      }),
    );
    await vector.clipboard.write({ text: "t", tabular: { rows: [["x"]] } });
    const got = await vector.clipboard.read();
    expect(got?.text).toBe("t");
    expect(got?.tabular).toBeUndefined();
    // Even a grid another plugin put there is not surfaced.
    await t.host.clipboard.write({
      text: "a\tb",
      tabular: { rows: [["a", "b"]] },
    });
    expect((await vector.clipboard.read())?.tabular).toBeUndefined();
  });

  test("an undeclared clipboard is a capability error", async () => {
    const none = t.withManifest(
      probeManifest("media.paged.probenoclip", {
        capabilities: { clipboard: "none" },
      }),
    );
    await expect(none.clipboard.read()).rejects.toThrow(/clipboard/);
    await expect(none.clipboard.write({ text: "x" })).rejects.toThrow(
      /clipboard/,
    );
  });
});

describe("host.clipboard — the editor's system-clipboard backing", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a grid copy puts TSV text/plain AND an HTML table on the system clipboard", async () => {
    await t.host.clipboard.write({
      text: "a\tb",
      tabular: { rows: [["a", "<b>"]] },
    });
    expect(t.editorApp!.platform.clipboard.current()).toEqual({
      "text/plain": "a\tb",
      "text/html": "<table><tr><td>a</td><td>&lt;b&gt;</td></tr></table>",
    });
  });

  test("text another application copied reads back as text and its TSV grid", async () => {
    t.editorApp!.platform.clipboard.putText("x\ty\r\n1\t2\n");
    expect(await t.host.clipboard.read()).toEqual({
      text: "x\ty\r\n1\t2\n",
      tabular: {
        rows: [
          ["x", "y"],
          ["1", "2"],
        ],
      },
    });
  });

  test("an empty clipboard reads null", async () => {
    t.editorApp!.platform.clipboard.putText("");
    expect(await t.host.clipboard.read()).toBeNull();
  });

  test("a platform refusal (no user gesture) resolves, never throws, and copies nothing", async () => {
    t.editorApp!.platform.clipboard.putText("before");
    t.editorApp!.platform.clipboard.setRefuse(true);
    try {
      await t.host.clipboard.write({ text: "after" });
    } finally {
      t.editorApp!.platform.clipboard.setRefuse(false);
    }
    expect((await t.host.clipboard.read())?.text).toBe("before");
  });
});

describe("host.clipboard, no backend wired — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("read null, write a no-op, supports false", async () => {
    expect(t.host.supports("clipboard@1")).toBe(false);
    await t.host.clipboard.write({ text: "x" });
    expect(await t.host.clipboard.read()).toBeNull();
  });
});

// ── host.secrets ─────────────────────────────────────────────────────

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const)("host.secrets, a store wired — %s", (name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  /** Store `secret` under `ref`, accepting the editor's prompt as the
   *  user would (the headless store takes it without one). */
  const set = async (ref: string, accept = true) => {
    const p = t.host.secrets.set(ref, "s3cr3t");
    const prompt = t.editorApp?.secrets.controller.current() ?? null;
    if (name === "editor") {
      expect(prompt?.ref).toBe(ref);
      expect(prompt?.pluginId).toBe(PROBE_ID);
      prompt!.decide(accept ? "s3cr3t" : null);
    }
    return p;
  };

  test("supports secrets@1, and the surface has no way to read a secret back", () => {
    expect(t.host.supports("secrets@1")).toBe(true);
    expect(Object.keys(t.host.secrets).sort()).toEqual([
      "exists",
      "forget",
      "set",
    ]);
  });

  test("set → exists true; forget → exists false; forget again is fine", async () => {
    await set("db-main");
    expect(await t.host.secrets.exists("db-main")).toBe(true);
    await t.host.secrets.forget("db-main");
    expect(await t.host.secrets.exists("db-main")).toBe(false);
    await t.host.secrets.forget("db-main");
  });

  test("another plugin does not see the ref", async () => {
    await set("shared-name");
    expect(await t.sibling().secrets.exists("shared-name")).toBe(false);
  });

  if (name === "editor")
    test("a declined prompt rejects set, and nothing is held", async () => {
      await expect(set("declined", false)).rejects.toThrow();
      expect(await t.host.secrets.exists("declined")).toBe(false);
    });

  test("an undeclared secrets door is a capability error", async () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenosecret", {
        capabilities: {},
      }),
    );
    await expect(narrow.secrets.exists("x")).rejects.toThrow(/secrets/);
  });
});

describe("host.secrets, no store wired — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("set rejects, exists false, forget a no-op, supports false", async () => {
    expect(t.host.supports("secrets@1")).toBe(false);
    await expect(t.host.secrets.set("r", "s")).rejects.toThrow(
      /no secret-store/,
    );
    expect(await t.host.secrets.exists("r")).toBe(false);
    await t.host.secrets.forget("r");
  });
});

void OTHER_ID;
