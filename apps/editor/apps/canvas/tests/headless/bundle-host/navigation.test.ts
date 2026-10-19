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

// THE BUNDLEHOST CONTRACT — the doors into the editor's chrome: page
// navigation and the active page (`host.viewport.goToPage / activePage /
// onDidChangeActivePage / revealText`), the text caret (`host.text.caret`),
// the shell (`host.shell.openPanel / closePanel / pickFile / saveFile /
// enterEditContext`), the module door (`host.modules`) and bundle workers
// (`host.workers`). What plugin-api documents, on every adapter it applies to
// (hosts.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  publishActivePage,
  setPageGoTo,
  setTextReveal,
} from "../../../src/plugin-pages";

import {
  PROBE_ID,
  bareAdapter,
  editorAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

// ── viewport: pages and text ─────────────────────────────────────────

describe("host.viewport pages and revealText — the editor's canvas", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    setPageGoTo(null);
    setTextReveal(null);
    publishActivePage(null);
    await t.dispose();
  });

  test("supports viewport.pages@1 and viewport.revealText@1", () => {
    expect(t.host.supports("viewport.pages@1")).toBe(true);
    expect(t.host.supports("viewport.revealText@1")).toBe(true);
  });

  test("goToPage reaches the canvas's navigation with the fit; false while the canvas has none", async () => {
    setPageGoTo(null);
    expect(await t.host.viewport.goToPage("p2")).toBe(false);
    const calls: unknown[] = [];
    setPageGoTo((pageId, fit) => {
      calls.push([pageId, fit]);
      return pageId === "p2";
    });
    expect(await t.host.viewport.goToPage("p2", { fit: "width" })).toBe(true);
    expect(await t.host.viewport.goToPage("nope")).toBe(false);
    expect(calls).toEqual([
      ["p2", "width"],
      ["nope", "page"],
    ]);
  });

  test("activePage follows the canvas, and only a change is announced", () => {
    const seen: Array<string | null> = [];
    const sub = t.host.viewport.onDidChangeActivePage((p) => seen.push(p));
    publishActivePage("p1");
    publishActivePage("p1");
    publishActivePage("p3");
    expect(t.host.viewport.activePage()).toBe("p3");
    sub.dispose();
    publishActivePage("p4");
    expect(seen).toEqual(["p1", "p3"]);
  });

  test("revealText hands the range and the select flag (default true) to the canvas", async () => {
    const calls: unknown[] = [];
    setTextReveal(async (range, select) => {
      calls.push([range, select]);
      return range.storyId === "s1";
    });
    const range = { storyId: "s1", start: 2, end: 5 };
    expect(await t.host.viewport.revealText(range)).toBe(true);
    expect(
      await t.host.viewport.revealText(
        { storyId: "gone", start: 0, end: 0 },
        { select: false },
      ),
    ).toBe(false);
    expect(calls).toEqual([
      [range, true],
      [{ storyId: "gone", start: 0, end: 0 }, false],
    ]);
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.viewport, no page backend — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("goToPage false, activePage null, revealText false; supports false", async () => {
    expect(t.host.supports("viewport.pages@1")).toBe(false);
    expect(t.host.supports("viewport.revealText@1")).toBe(false);
    expect(await t.host.viewport.goToPage("p1")).toBe(false);
    expect(t.host.viewport.activePage()).toBeNull();
    const sub = t.host.viewport.onDidChangeActivePage(() => {
      throw new Error("never fires");
    });
    sub.dispose();
    expect(
      await t.host.viewport.revealText({ storyId: "s", start: 0, end: 0 }),
    ).toBe(false);
  });

  test("camera() is a snapshot and pxToPt divides by its scale", () => {
    const cam = t.host.viewport.camera();
    expect(cam).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(t.host.viewport.pxToPt(10)).toBe(10 / cam.scale);
  });
});

// ── text.caret ───────────────────────────────────────────────────────

describe("host.text.caret — the editor's content selection", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a collapsed caret answers its story and offset; a range answers its start", () => {
    expect(t.host.supports("text.caret@1")).toBe(true);
    t.editorApp!.caret.current = { storyId: "u1", start: 7 };
    expect(t.host.text.caret()).toEqual({ storyId: "u1", offset: 7 });
  });

  test("no caret, and a caret in a table cell, answer null", () => {
    t.editorApp!.caret.current = null;
    expect(t.host.text.caret()).toBeNull();
    t.editorApp!.caret.current = { storyId: "u1", start: 3, cell: { r: 0 } };
    expect(t.host.text.caret()).toBeNull();
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.text.caret, no reader — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("null, and supports(text.caret@1) false", () => {
    expect(t.host.supports("text.caret@1")).toBe(false);
    expect(t.host.text.caret()).toBeNull();
  });
});

// ── shell ────────────────────────────────────────────────────────────

describe("host.shell — the editor's cockpit, picker and saver", () => {
  let t: HostUnderTest;
  const clicked: Array<{ download: string; href: string }> = [];
  const blobs = new Map<string, Blob>();
  let pickedInput: HTMLInputElement | null = null;
  beforeAll(async () => {
    t = await editorAdapter();
    GlobalRegistrator.register();
    // Record the anchor download and the file input instead of letting the
    // DOM act on them.
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    };
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      pickedInput = this;
    };
    URL.createObjectURL = (b: Blob) => {
      const url = `blob:probe/${blobs.size}`;
      blobs.set(url, b);
      return url;
    };
    URL.revokeObjectURL = () => {};
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
    await t.dispose();
  });

  test("supports the shell doors", () => {
    for (const f of [
      "shell.openPanel@1",
      "shell.pickFile@1",
      "shell.saveFile@1",
      "shell.enterEditContext@1",
    ])
      expect(t.host.supports(f)).toBe(true);
  });

  test("openPanel / closePanel reach the cockpit", () => {
    t.host.shell.openPanel(`${PROBE_ID}.panel.one`);
    t.host.shell.closePanel(`${PROBE_ID}.panel.one`);
    expect(t.editorApp!.opened.filter((o) => o.kind.endsWith("Panel"))).toEqual(
      [
        { kind: "openPanel", detail: `${PROBE_ID}.panel.one` },
        { kind: "closePanel", detail: `${PROBE_ID}.panel.one` },
      ],
    );
  });

  test("pickFile opens a picker with the accept filter; a cancel resolves []", async () => {
    pickedInput = null;
    const pending = t.host.shell.pickFile({
      accept: [".xlsx", "text/csv"],
      multiple: true,
    });
    expect(pickedInput).not.toBeNull();
    expect(pickedInput!.type).toBe("file");
    expect(pickedInput!.accept).toBe(".xlsx,text/csv");
    expect(pickedInput!.multiple).toBe(true);
    pickedInput!.oncancel?.(new Event("cancel"));
    expect(await pending).toEqual([]);
  });

  test("pickFile resolves the chosen files' bytes, name and type", async () => {
    pickedInput = null;
    const pending = t.host.shell.pickFile();
    const file = new File([new Uint8Array([1, 2, 3])], "book.xlsx", {
      type: "application/vnd.ms-excel",
    });
    Object.defineProperty(pickedInput!, "files", { value: [file] });
    await pickedInput!.onchange?.(new Event("change"));
    const got = await pending;
    expect(got.map((f) => [f.name, f.mimeType, Array.from(f.bytes)])).toEqual([
      ["book.xlsx", "application/vnd.ms-excel", [1, 2, 3]],
    ]);
  });

  test("saveFile delivers the bytes as a download under a sanitized leaf name", async () => {
    clicked.length = 0;
    const ok = await t.host.shell.saveFile({
      suggestedName: "../../etc/report<1>.png",
      bytes: new Uint8Array([9, 8]),
      mimeType: "image/png",
    });
    expect(ok).toBe(true);
    expect(clicked.map((c) => c.download)).toEqual(["report1.png"]);
    const blob = blobs.get(clicked[0]!.href)!;
    expect(blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
      9, 8,
    ]);
  });

  test("enterEditContext enters this bundle's own context through the shell, and refuses a foreign type", async () => {
    t.host.contribute.editContext({
      type: "probeFrame",
      title: "Probe",
      matches: () => true,
    } as never);
    expect(
      await t.host.shell.enterEditContext("probeFrame", {
        kind: "rectangle",
        id: "u1",
      } as never),
    ).toBe(true);
    expect(
      t.editorApp!.opened.filter((o) => o.kind === "enterEditContext"),
    ).toEqual([
      {
        kind: "enterEditContext",
        detail: {
          type: "probeFrame",
          elementId: { kind: "rectangle", id: "u1" },
        },
      },
    ]);
    await expect(
      t.host.shell.enterEditContext("sheet", {
        kind: "rectangle",
        id: "u1",
      } as never),
    ).rejects.toThrow(/registered no edit context/);
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.shell, no shell actions — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("openPanel is ignored, pickFile resolves [], saveFile false; supports false", async () => {
    expect(t.host.supports("shell.openPanel@1")).toBe(false);
    expect(t.host.supports("shell.pickFile@1")).toBe(false);
    expect(t.host.supports("shell.saveFile@1")).toBe(false);
    t.host.shell.openPanel(`${PROBE_ID}.panel.one`);
    t.host.shell.closePanel(`${PROBE_ID}.panel.one`);
    expect(await t.host.shell.pickFile()).toEqual([]);
    expect(
      await t.host.shell.saveFile({
        suggestedName: "x.bin",
        bytes: new Uint8Array(1),
      }),
    ).toBe(false);
  });
});

// ── modules ──────────────────────────────────────────────────────────

describe("host.modules — the editor's module manifest", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("a declared artifact resolves to the dev server's /@fs/ URL with the measured integrity", async () => {
    expect(t.host.supports("modules@1")).toBe(true);
    const hosted = await t.host.modules.resolve("probe");
    expect(hosted).toEqual({
      url: "http://localhost:5180/@fs/repo/modules/probe/wasm/probe.wasm",
      integrity: "sha384-probe",
      artifact: { name: "probe", path: "wasm/probe.wasm", purpose: "compute" },
    });
    expect(await t.host.modules.url("probe")).toBe(hosted!.url);
  });

  test("an undeclared artifact name is a capability error", async () => {
    await expect(t.host.modules.resolve("other")).rejects.toThrow(
      /capabilities\.wasm/,
    );
  });

  test("an artifact the manifest declares but the build does not serve answers null", async () => {
    const other = t.withManifest(
      probeManifest("media.paged.probemod", {
        capabilities: {
          wasm: [{ name: "x", path: "wasm/x.wasm", purpose: "compute" }],
        },
      }),
    );
    expect(await other.modules.resolve("x")).toBeNull();
    expect(await other.modules.fetch("x")).toBeNull();
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.modules, no backend — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("every answer is null and supports(modules@1) false", async () => {
    expect(t.host.supports("modules@1")).toBe(false);
    expect(await t.host.modules.resolve("probe")).toBeNull();
    expect(await t.host.modules.url("probe")).toBeNull();
    expect(await t.host.modules.fetch("probe")).toBeNull();
  });
});

// ── workers ──────────────────────────────────────────────────────────

const ECHO = fileURLToPath(
  new URL("./fixtures/echo-worker.ts", import.meta.url),
);

describe("host.workers — the editor's worker backend", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
    t.editorApp!.workerResolvers[PROBE_ID] = (module) =>
      module === "workers/echo.js" ? ECHO : null;
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("concurrency is min(declared max, hardwareConcurrency, 8)", () => {
    expect(t.host.supports("workers@1")).toBe(true);
    expect(t.host.workers.concurrency()).toBe(
      Math.min(2, navigator.hardwareConcurrency ?? 2, 8),
    );
  });

  test("a declared module spawns, answers messages, and stops on terminate", async () => {
    const w = await t.host.workers.spawn({
      module: "workers/echo.js",
      name: "echo",
    });
    try {
      const got = await new Promise<unknown>((resolve) => {
        const sub = w.onMessage((m) => {
          sub.dispose();
          resolve(m);
        });
        w.post({ n: 1 });
      });
      expect(got).toEqual({ echo: { n: 1 } });
    } finally {
      w.terminate();
      w.terminate(); // idempotent
    }
  });

  test("a module the bundle does not ship rejects", async () => {
    await expect(
      t.host.workers.spawn({ module: "workers/other.js" }),
    ).rejects.toThrow(/ships no worker module/);
  });

  test("past the granted count, spawn rejects", async () => {
    const a = await t.host.workers.spawn({ module: "workers/echo.js" });
    const b = await t.host.workers.spawn({ module: "workers/echo.js" });
    await expect(
      t.host.workers.spawn({ module: "workers/echo.js" }),
    ).rejects.toThrow();
    a.terminate();
    b.terminate();
  });

  test("allocateShared is null without capabilities.workers.sharedMemory", async () => {
    const w = await t.host.workers.spawn({ module: "workers/echo.js" });
    expect(w.allocateShared(1024)).toBeNull();
    w.terminate();
  });
});

describe.each([
  ["headless", headlessAdapter],
  ["bare", bareAdapter],
] as const)("host.workers, no backend — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("spawn rejects, concurrency 0, supports(workers@1) false", async () => {
    expect(t.host.supports("workers@1")).toBe(false);
    expect(t.host.workers.concurrency()).toBe(0);
    await expect(
      t.host.workers.spawn({ module: "workers/echo.js" }),
    ).rejects.toThrow();
  });
});
