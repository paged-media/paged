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

// ADR 289 (D-63) — the vector clipboard's pure half: which content a paste
// takes (an SVG document in plain text, as Illustrator writes it, before
// the browser's sanitised `image/svg+xml`; our own marked copy before
// either), and what the browser clipboard and the bundles' backend write
// and read. The engine half (copy → SVG → paste) is
// tests/headless/commands-vector-clipboard.test.ts.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  browserClipboard,
  plainTextOf,
  resolvePaste,
  svgDocumentOf,
} from "../../../src/clipboard-commands";
import { createEditorClipboardBackend } from "../../../src/plugin-clipboard";

// Illustrator 30.1's Edit ▸ Copy, as recorded by
// modules/draw/scripts/illustrator/run-clipboard-probe.sh.
const ILLUSTRATOR_SVG = await Bun.file(
  new URL(
    "../../fixtures/clipboard/clipboard-copy.illustrator.svg",
    import.meta.url,
  ),
).text();
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

/** A stand-in for the async clipboard: one item of typed blobs.
 *  `supports` is what `ClipboardItem.supports` answers; `refuses`, a type
 *  the write then rejects all the same. */
function fakeClipboard(supports: (t: string) => boolean, refuses?: string) {
  const store: { item: Record<string, Blob> | null; writes: number } = {
    item: null,
    writes: 0,
  };
  class FakeItem {
    static supports = supports;
    readonly types: string[];
    constructor(readonly forms: Record<string, Blob>) {
      this.types = Object.keys(forms);
    }
    async getType(t: string): Promise<Blob> {
      return this.forms[t];
    }
  }
  const clipboard = {
    async write(items: FakeItem[]) {
      for (const t of items[0].types)
        if (!supports(t) || t === refuses)
          throw new Error(`NotAllowedError: ${t}`);
      store.writes += 1;
      store.item = items[0].forms;
    },
    async read() {
      return store.item ? [new FakeItem(store.item)] : [];
    },
    async writeText(text: string) {
      store.item = { "text/plain": new Blob([text]) };
    },
    async readText() {
      return store.item?.["text/plain"]
        ? await store.item["text/plain"].text()
        : "";
    },
  };
  const g = globalThis as Record<string, unknown>;
  const saved = { item: g.ClipboardItem, nav: g.navigator };
  g.ClipboardItem = FakeItem;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
    writable: true,
  });
  restore = () => {
    g.ClipboardItem = saved.item;
    Object.defineProperty(globalThis, "navigator", {
      value: saved.nav,
      configurable: true,
      writable: true,
    });
  };
  return store;
}
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const text = async (b: Blob | undefined) => (b ? await b.text() : undefined);

describe("ADR 289: the vector clipboard [editor-shell.vector-clipboard]", () => {
  test("an SVG document is recognised in text, with a declaration, comments and a doctype; nothing else is", () => {
    expect(svgDocumentOf(ILLUSTRATOR_SVG)).toBe(ILLUSTRATOR_SVG.trim());
    expect(
      svgDocumentOf(
        '﻿<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n' +
          SVG,
      ),
    ).not.toBeNull();
    expect(svgDocumentOf("Hello <svg> world")).toBeNull();
    expect(svgDocumentOf("<svg-like>")).toBeNull();
    expect(svgDocumentOf('<svg xmlns="x">unterminated')).toBeNull();
    expect(svgDocumentOf("")).toBeNull();
  });

  test("a paste takes Illustrator's SVG (its plain text) over the sanitised flavour; our marked copy still wins", () => {
    covers("command:paged.edit.paste");
    const sanitised = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(
      resolvePaste({ text: ILLUSTRATOR_SVG, html: "", svg: sanitised }, null),
    ).toEqual({ kind: "svg", svg: ILLUSTRATOR_SVG.trim() });
    // A browser that exposes the SVG flavour only.
    expect(resolvePaste({ text: "", html: "", svg: SVG }, null)).toEqual({
      kind: "svg",
      svg: SVG,
    });
    // Plain text beside an SVG flavour: the drawing is the richer form.
    expect(
      resolvePaste({ text: "a caption", html: "", svg: SVG }, null),
    ).toEqual({ kind: "svg", svg: SVG });
    // Our own copy, marker intact, is the snippet whatever else is there.
    const ours = {
      snippet: "{S}",
      text: "",
      svg: SVG,
      count: 1,
      token: "t1",
    };
    expect(
      resolvePaste(
        { text: SVG, html: '<div data-paged-clip="t1"></div>', svg: SVG },
        ours,
      ),
    ).toEqual({ kind: "items", snippet: "{S}" });
    // …and so is its plain text alone (a browser that kept text only):
    // with no frame text that text is its SVG code.
    expect(plainTextOf(ours)).toBe(SVG);
    expect(resolvePaste({ text: SVG, html: "" }, ours)).toEqual({
      kind: "items",
      snippet: "{S}",
    });
  });

  test("Copy writes image/svg+xml beside text and HTML where the browser takes it, and leaves it out where it does not", async () => {
    covers("command:paged.edit.copy");
    const all = fakeClipboard(() => true);
    expect(
      await browserClipboard().write({ text: "t", html: "<b>h</b>", svg: SVG }),
    ).toBe(true);
    expect(await text(all.item?.["image/svg+xml"])).toBe(SVG);
    expect(await text(all.item?.["text/plain"])).toBe("t");
    expect(await text(all.item?.["text/html"])).toBe("<b>h</b>");
    // Read back: all three forms.
    expect(await browserClipboard().read()).toEqual({
      text: "t",
      html: "<b>h</b>",
      svg: SVG,
    });
    restore?.();

    // Safari, Firefox: text and HTML only.
    const plain = fakeClipboard((t) => t === "text/plain" || t === "text/html");
    expect(
      await browserClipboard().write({ text: "t", html: "h", svg: SVG }),
    ).toBe(true);
    expect(plain.item?.["image/svg+xml"]).toBeUndefined();
    expect(await text(plain.item?.["text/plain"])).toBe("t");
  });

  test("a browser that names the SVG type but refuses the write still gets text and HTML", async () => {
    const store = fakeClipboard(() => true, "image/svg+xml");
    expect(
      await browserClipboard().write({ text: "t", html: "h", svg: SVG }),
    ).toBe(true);
    expect(store.item?.["image/svg+xml"]).toBeUndefined();
    expect(await text(store.item?.["text/html"])).toBe("h");
  });

  test("the bundles' backend carries svg: written as image/svg+xml, read from SVG plain text first, never parsed as a grid", async () => {
    const store = fakeClipboard(() => true);
    const backend = createEditorClipboardBackend();
    expect(backend.svg).toBe(true);
    await backend.write({ svg: SVG });
    expect(await text(store.item?.["image/svg+xml"])).toBe(SVG);
    // No text half given: the plain text is the SVG code.
    expect(await text(store.item?.["text/plain"])).toBe(SVG);
    expect(await backend.read()).toEqual({ text: SVG, svg: SVG });

    // Illustrator's clipboard as Chromium exposes it: the source in plain
    // text, the sanitised SVG without its <style>.
    store.item = {
      "text/plain": new Blob([ILLUSTRATOR_SVG]),
      "image/svg+xml": new Blob(['<svg xmlns="x"><rect/></svg>']),
    };
    const back = await backend.read();
    expect(back?.svg).toBe(ILLUSTRATOR_SVG.trim());
    expect(back?.tabular).toBeUndefined();

    // A grid copy with a drawing: the table and the SVG together.
    await backend.write({ tabular: { rows: [["a", "b"]] }, svg: SVG });
    expect(await text(store.item?.["text/plain"])).toBe("a\tb");
    expect(await text(store.item?.["image/svg+xml"])).toBe(SVG);
    expect(store.item?.["text/html"]).toBeDefined();
  });
});
