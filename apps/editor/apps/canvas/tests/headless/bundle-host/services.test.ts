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

// THE BUNDLEHOST CONTRACT — the host services: `host.network` (consent),
// `host.dataProviders`, `host.bindings`, `host.diagnostics`,
// `host.journal`, `host.tools`, `host.document.onWillSave`. What plugin-api
// documents, on every adapter it applies to (hosts.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { journal } from "@paged-media/client";

import {
  OTHER_ID,
  PROBE_ID,
  bareAdapter,
  editorAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

const ORIGIN = "https://data.example.org";
const OUTSIDE = "https://elsewhere.example.com";

// ── host.network ─────────────────────────────────────────────────────

describe("host.network — the editor's consent prompt", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("supports network.consent@1; nothing is consented before a request", () => {
    expect(t.host.supports("network.consent@1")).toBe(true);
    expect(t.host.network.consentedOrigins()).toEqual([]);
  });

  test("a request prompts with the declared origins and the purpose; the user's grant is the answer", async () => {
    const pending = t.host.network.requestConsent(
      [ORIGIN, OUTSIDE],
      "read the price list",
    );
    const prompt = t.editorApp!.consent.controller.current();
    // An origin outside capabilities.network is denied without a prompt.
    expect(prompt?.origins).toEqual([ORIGIN]);
    expect(prompt?.purpose).toBe("read the price list");
    prompt!.decide({ granted: [ORIGIN], remember: false });
    expect(await pending).toEqual({
      granted: [ORIGIN],
      denied: [OUTSIDE],
      remembered: false,
    });
    expect(t.host.network.consentedOrigins()).toEqual([ORIGIN]);
  });

  test("a granted origin is not asked again", async () => {
    const result = await t.host.network.requestConsent([ORIGIN], "again");
    expect(t.editorApp!.consent.controller.current()).toBeNull();
    expect(result.granted).toEqual([ORIGIN]);
  });

  test("closing the prompt without a grant denies", async () => {
    const other = t.sibling(
      probeManifest(OTHER_ID, {
        capabilities: { network: { origins: [ORIGIN] } },
      }),
    );
    const pending = other.network.requestConsent([ORIGIN], "x");
    t.editorApp!.consent.controller.current()!.decide({
      granted: [],
      remember: false,
    });
    expect(await pending).toEqual({
      granted: [],
      denied: [ORIGIN],
      remembered: false,
    });
    expect(other.network.consentedOrigins()).toEqual([]);
  });

  // ConsentResult.remembered: "Whether the grant was remembered for THIS
  // DOCUMENT (survives reopen)". The SDK keeps a remembered grant in the
  // plugin's own KV storage, which is per browser, so it holds for every
  // document the bundle meets afterwards, not only the one that asked.
  test.failing(
    "HOST-5 — a grant remembered for one document is not consented for the next",
    async () => {
      const fresh = t.sibling(
        probeManifest("media.paged.proberemember", {
          capabilities: { network: { origins: [ORIGIN] } },
        }),
      );
      const pending = fresh.network.requestConsent([ORIGIN], "remember me");
      t.editorApp!.consent.controller.current()!.decide({
        granted: [ORIGIN],
        remember: true,
      });
      expect((await pending).remembered).toBe(true);
      // Another document, in a later session: the bundle is activated
      // again (a reload) and meets a document that never asked.
      await t.newBlank();
      const later = t.sibling(
        probeManifest("media.paged.proberemember", {
          capabilities: { network: { origins: [ORIGIN] } },
        }),
      );
      expect(later.network.consentedOrigins()).toEqual([]);
    },
  );
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.network, no consent backend — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("every origin is denied and supports(network.consent@1) is false", async () => {
    expect(t.host.supports("network.consent@1")).toBe(false);
    expect(await t.host.network.requestConsent([ORIGIN], "x")).toEqual({
      granted: [],
      denied: [ORIGIN],
      remembered: false,
    });
    expect(t.host.network.consentedOrigins()).toEqual([]);
  });

  test("an undeclared network capability is a capability error", async () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenonet", { capabilities: {} }),
    );
    await expect(narrow.network.requestConsent([ORIGIN], "x")).rejects.toThrow(
      /capabilities\.network/,
    );
  });
});

// ── host.dataProviders ───────────────────────────────────────────────

const RECORDS = {
  schema: { fields: [{ name: "sku", ty: "text" }] },
  columns: [["A-1", "B-2"]],
  rowCount: 2,
};

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const)("host.dataProviders, a shared registry — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a provider one plugin registers is discovered and read by another, without rows in discovery", async () => {
    expect(t.host.supports("dataProviders@1")).toBe(true);
    let pulls = 0;
    const handle = t.host.dataProviders.register({
      id: "prices",
      category: "table",
      schema: RECORDS.schema,
      revision: "r1",
      getSnapshot: () => {
        pulls += 1;
        return RECORDS;
      },
    });
    const consumer = t.sibling(
      probeManifest(OTHER_ID, {
        capabilities: { dataProviders: { consume: ["table"] } },
      }),
    );
    expect(consumer.dataProviders.discover("table")).toEqual([
      {
        id: "prices",
        category: "table",
        schema: RECORDS.schema,
        revision: "r1",
      },
    ]);
    // Discovery never pulls: the snapshot is lazy.
    expect(pulls).toBe(0);
    expect(await consumer.dataProviders.get("prices")).toEqual({
      id: "prices",
      revision: "r1",
      records: RECORDS,
    });
    expect(pulls).toBe(1);

    const seen: string[] = [];
    const sub = consumer.dataProviders.onDidChange("prices", (r) =>
      seen.push(r),
    );
    handle.update("r2");
    expect(seen).toEqual(["r2"]);
    expect(consumer.dataProviders.discover("table")[0]?.revision).toBe("r2");

    handle.dispose();
    expect(consumer.dataProviders.discover("table")).toEqual([]);
    expect(await consumer.dataProviders.get("prices")).toBeNull();
    sub.dispose();
  });

  test("publishing outside capabilities.dataProviders.publish is a capability error", () => {
    expect(() =>
      t.host.dataProviders.register({
        id: "x",
        category: "chart",
        schema: { fields: [] },
        revision: "1",
        getSnapshot: () => RECORDS,
      }),
    ).toThrow(/publish/);
  });

  test("consuming outside capabilities.dataProviders.consume is a capability error", () => {
    expect(() => t.host.dataProviders.discover("chart")).toThrow(/consume/);
  });
});

describe("host.dataProviders, no registry — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("register is an inert handle, discover empty, get null, supports false", async () => {
    expect(t.host.supports("dataProviders@1")).toBe(false);
    const h = t.host.dataProviders.register({
      id: "prices",
      category: "table",
      schema: RECORDS.schema,
      revision: "r1",
      getSnapshot: () => RECORDS,
    });
    h.update("r2");
    h.dispose();
    expect(t.host.dataProviders.discover("table")).toEqual([]);
    expect(await t.host.dataProviders.get("prices")).toBeNull();
  });
});

// ── host.bindings, host.diagnostics, host.journal ────────────────────

describe.each([
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.bindings and host.diagnostics — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("bindings: publish/get/delete, each change named to subscribers, per bundle", () => {
    const b = t.host.bindings;
    const changed: string[] = [];
    const sub = b.onDidChange((n) => changed.push(n));
    b.publish("canExpand", true);
    b.publish("count", 3);
    expect(b.get("canExpand")).toBe(true);
    expect(b.get("count")).toBe(3);
    expect(t.sibling().bindings.get("canExpand")).toBeUndefined();
    b.delete("canExpand");
    expect(b.get("canExpand")).toBeUndefined();
    b.delete("never-published"); // nothing changed, nothing announced
    expect(changed).toEqual(["canExpand", "count", "canExpand"]);
    sub.dispose();
    b.publish("count", 4);
    expect(changed).toHaveLength(3);
  });

  test("diagnostics: set/get per key, clear one key or all, each change announced", () => {
    const d = t.host.diagnostics;
    const changed: string[] = [];
    const sub = d.onDidChange((k) => changed.push(k));
    const err = { severity: "error" as const, message: "bad", line: 3 };
    d.set("html", [err]);
    d.set("css", [{ severity: "warning", message: "meh" }]);
    expect(d.get("html")).toEqual([err]);
    expect(d.get("none")).toEqual([]);
    d.clear("html");
    expect(d.get("html")).toEqual([]);
    expect(d.get("css")).toHaveLength(1);
    d.clear();
    expect(d.get("css")).toEqual([]);
    expect(changed).toEqual(["html", "css", "html", ""]);
    sub.dispose();
  });
});

describe("host.diagnostics — the editor's Problems panel", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a bundle's diagnostics are listed attributed to it, errors first, and leave with clear", () => {
    expect(t.host.supports("diagnostics.publish@1")).toBe(true);
    t.host.diagnostics.set("css", [{ severity: "warning", message: "w" }]);
    t.host.diagnostics.set("html", [{ severity: "error", message: "e" }]);
    expect(
      t.editorApp!.problems().map((p) => [p.bundleId, p.key, p.severity]),
    ).toEqual([
      [PROBE_ID, "html", "error"],
      [PROBE_ID, "css", "warning"],
    ]);
    t.host.diagnostics.clear("html");
    expect(t.editorApp!.problems().map((p) => p.key)).toEqual(["css"]);
    t.host.diagnostics.clear();
    expect(t.editorApp!.problems()).toEqual([]);
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.journal, no ring wired — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("inert, never throwing, and supports(journal@1) false", async () => {
    expect(t.host.supports("journal@1")).toBe(false);
    t.host.journal.record({ code: `${PROBE_ID}.panel.reload` });
    t.host.journal.record({ code: "not.namespaced" });
    // `time` passes the thunk's result and its throw through unchanged.
    expect(await t.host.journal.time(`${PROBE_ID}.op`, () => 42)).toBe(42);
    await expect(
      t.host.journal.time(`${PROBE_ID}.op`, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("host.journal — the editor", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  // The journal is "a local, in-memory flight recorder" a bundle records
  // into (ADR 025); the editor keeps one (the Journal panel, the bug-report
  // export) and records the bundles' lifecycle there, but does not pass it
  // to the bundle hosts (`journal` is not among the editor's host options),
  // so `host.journal` is inert in the editor: paged.draw's panel-reload
  // entries (use-panel-reload.ts) go nowhere.
  test.failing(
    "HOST-4 — a bundle's journal entry lands in the editor's journal",
    () => {
      const before = journal.entries().length;
      t.host.journal.record({
        code: `${PROBE_ID}.panel.reload`,
        data: { panel: "probe" },
      });
      expect(t.host.supports("journal@1")).toBe(true);
      expect(journal.entries().length).toBe(before + 1);
    },
  );
});

// ── host.tools ───────────────────────────────────────────────────────

describe("host.tools — the editor's tool-options store", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("settings() reads what the tool-options popover wrote; onDidChangeSettings fires with the new values", () => {
    const tool = `${PROBE_ID}.tool.one`;
    expect(t.host.supports("tools.settings@1")).toBe(true);
    expect(t.host.tools.settings(tool)).toEqual({});
    const seen: unknown[] = [];
    const sub = t.host.tools.onDidChangeSettings(tool, (s) => seen.push(s));
    t.editorApp!.toolSettings.set(tool, "sides", 6);
    t.editorApp!.toolSettings.set(tool, "star", true);
    expect(t.host.tools.settings(tool)).toEqual({ sides: 6, star: true });
    expect(seen).toEqual([{ sides: 6 }, { sides: 6, star: true }]);
    sub.dispose();
    t.editorApp!.toolSettings.set(tool, "sides", 7);
    expect(seen).toHaveLength(2);
  });

  test("only this bundle's own tools can be read", () => {
    expect(() => t.host.tools.settings("paged.tool.rectangle")).toThrow();
  });
});

describe("host.tools, no store — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("settings {} and supports(tools.settings@1) false", () => {
    expect(t.host.supports("tools.settings@1")).toBe(false);
    expect(t.host.tools.settings(`${PROBE_ID}.tool.one`)).toEqual({});
  });
});

// ── host.document.onWillSave ─────────────────────────────────────────

describe("host.document.onWillSave — the editor's save", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("Save waits for the listener; a throwing listener does not stop the save", async () => {
    expect(t.host.supports("document.onWillSave@1")).toBe(true);
    const order: string[] = [];
    const a = t.host.document.onWillSave(async (e) => {
      expect(e).toEqual({ format: "paged" });
      await new Promise((r) => setTimeout(r, 10));
      order.push("committed");
    });
    const b = t.sibling().document.onWillSave(() => {
      throw new Error("sibling failed");
    });
    const outcome = await t.editorApp!.willSave.run({ format: "paged" });
    order.push("exported");
    expect(order).toEqual(["committed", "exported"]);
    // The SDK contains the throw (it is logged), so the save sees no failure.
    expect(outcome).toEqual({ failed: [], timedOut: [] });
    a.dispose();
    b.dispose();
    expect(t.editorApp!.willSave.size()).toBe(0);
  });
});

describe("host.document.onWillSave, no backend — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("the listener is held, never called, and supports is false", () => {
    expect(t.host.supports("document.onWillSave@1")).toBe(false);
    const d = t.host.document.onWillSave(() => {
      throw new Error("never called");
    });
    d.dispose();
  });
});
