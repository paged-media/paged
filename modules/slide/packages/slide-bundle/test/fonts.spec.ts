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

// The fonts a deck embeds reach the document (ADR 707): File ▸ Open hands
// every face the licence allows to the host's document-font door before the
// document opens, says what the host refused, and a deck document opened
// later gets its faces again from the source deck it keeps. The engine is
// the real slide wasm over the PowerPoint-authored `fonts` fixture; the host
// is a recording fake.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Diagnostic, Disposable, ImporterContribution } from "@paged-media/plugin-api";

import { activate, FONT_DIAGNOSTICS, IMPORT_DIAGNOSTICS, SOURCE_PART } from "../src/activate";
import type { EmbeddedFaceReport } from "../src/engine";
import { type DocumentFontOutcome, usableFaces } from "../src/fonts";

const FONTS = new Uint8Array(
  readFileSync(new URL("../../../slide-conformance/fixtures/fonts.pptx", import.meta.url)),
);

interface Call {
  family: string;
  style?: string;
  magic: string;
  at: number;
}

function fontHost(options: {
  door?: boolean;
  answer?: (family: string, style?: string) => DocumentFontOutcome;
  source?: Uint8Array | null;
}) {
  const features = new Set([
    "contribute.importer@1",
    "document.openNative@1",
    "storage.parts@1",
    "document.onDidOpen@1",
    ...(options.door === false ? [] : ["assets.documentFont@1"]),
  ]);
  const importers: ImporterContribution[] = [];
  const calls: Call[] = [];
  const events: string[] = [];
  const parts = new Map<string, Uint8Array>();
  if (options.source) parts.set(SOURCE_PART, options.source);
  const diagnostics = new Map<string, Diagnostic[]>();
  const opened: Array<() => void> = [];
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: (f: string) => features.has(f),
    contribute: {
      importer(c: ImporterContribution): Disposable {
        importers.push(c);
        return { dispose() {} };
      },
    },
    assets: {
      async registerDocumentFont(bytes: Uint8Array, family: string, style?: string) {
        const magic = Array.from(bytes.subarray(0, 4)).join(",");
        calls.push({ family, style, magic, at: events.length });
        events.push(`font ${family} ${style}`);
        return options.answer?.(family, style) ?? { status: "registered", pageIds: [] };
      },
    },
    nativeDocument: {
      async open() {
        events.push("open");
      },
    },
    document: {
      async mutate() {
        return { applied: true, createdId: null, pageIds: [] };
      },
      // An empty document: the fingerprints the importer keeps are read here.
      tree: async () => [],
      elementGeometry: async () => [],
      collection: async () => [],
      frameChain: async () => [],
      storyContent: async () => null,
      onDidOpen(listener: () => void): Disposable {
        opened.push(listener);
        return { dispose() {} };
      },
    },
    parts: {
      async read(path: string) {
        return parts.get(path) ?? null;
      },
      async write(path: string, bytes: Uint8Array) {
        parts.set(path, bytes);
      },
    },
    diagnostics: {
      set(key: string, d: Diagnostic[]) {
        diagnostics.set(key, d);
      },
    },
  } as unknown as BundleHost;
  return { host, importers, calls, events, diagnostics, parts, fireOpened: () => opened.forEach((l) => l()) };
}

const STYLES = [
  "Caveat Regular",
  "Caveat Bold",
  "Gloria Hallelujah Regular",
  "Lato Regular",
  "Lato Bold",
  "Lato Italic",
  "Lato Bold Italic",
];

describe("a deck's embedded fonts", () => {
  it("are given to the document before it opens, each style as a TrueType face", async () => {
    const r = fontHost({});
    activate(r.host);
    await r.importers[0].import({ name: "fonts.pptx", bytes: FONTS, mimeType: "" });
    expect(r.calls.map((c) => `${c.family} ${c.style}`).sort()).toEqual([...STYLES].sort());
    expect(r.calls.every((c) => c.magic === "0,1,0,0")).toBe(true);
    // Every face before the document: it lays out in them from the start.
    expect(r.events.indexOf("open")).toBe(STYLES.length);
    const messages = (r.diagnostics.get(IMPORT_DIAGNOSTICS) ?? []).map((d) => d.message);
    expect(messages.filter((m) => /embedded font|cannot give/i.test(m))).toEqual([]);
  });

  it("are named when the host refuses one", async () => {
    const r = fontHost({
      answer: (family, style) =>
        family === "Lato" && style === "Bold"
          ? { status: "refused", reason: "over the per-face cap" }
          : family === "Caveat"
            ? { status: "held" }
            : { status: "registered", pageIds: [] },
    });
    activate(r.host);
    await r.importers[0].import({ name: "fonts.pptx", bytes: FONTS, mimeType: "" });
    const warnings = (r.diagnostics.get(IMPORT_DIAGNOSTICS) ?? []).filter((d) =>
      d.message.includes("embedded font"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("“Lato” (Bold) was not loaded: over the per-face cap");
    expect(warnings[0].message).toContain("substitute");
  });

  it("are reported, not lost silently, on a host without the document-font door", async () => {
    const r = fontHost({ door: false });
    activate(r.host);
    await r.importers[0].import({ name: "fonts.pptx", bytes: FONTS, mimeType: "" });
    expect(r.calls).toEqual([]);
    expect(r.events).toEqual(["open"]);
    const line = (r.diagnostics.get(IMPORT_DIAGNOSTICS) ?? []).find((d) => d.message.includes("cannot give"));
    expect(line?.message).toContain("Caveat, Gloria Hallelujah, Lato");
  });

  it("come back from the kept source deck when a deck document is opened again", async () => {
    // A deck document already open when the bundle activates.
    const r = fontHost({ source: FONTS });
    activate(r.host);
    await vi.waitFor(() => expect(r.calls).toHaveLength(STYLES.length));
    expect(r.diagnostics.get(FONT_DIAGNOSTICS)).toEqual([]);
    // And one opened later.
    r.fireOpened();
    await vi.waitFor(() => expect(r.calls).toHaveLength(2 * STYLES.length));
  });

  it("are left alone for a document that is not a deck", async () => {
    const r = fontHost({ source: null });
    activate(r.host);
    r.fireOpened();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.calls).toEqual([]);
    expect(r.diagnostics.has(FONT_DIAGNOSTICS)).toBe(false);
  });

  it("are used only when their licence allows an editable document", () => {
    const face = (use: EmbeddedFaceReport["use"], length = 10): EmbeddedFaceReport => ({
      family: "F",
      style: "Regular",
      part: "ppt/fonts/font1.fntdata",
      use,
      fsType: 0,
      subset: false,
      offset: 0,
      length,
    });
    const all: EmbeddedFaceReport[] = [
      face("editable"),
      face("previewAndPrint", 0),
      face("restricted", 0),
      face("bitmapOnly", 0),
      face("sitesOnly", 0),
      face("unreadable", 0),
      face("missing", 0),
    ];
    expect(usableFaces(all).map((f) => f.use)).toEqual(["editable"]);
  });
});
