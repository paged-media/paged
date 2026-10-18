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

// File ▸ Open of a deck, against a recording host: the importer is declared,
// opens the package the engine wrote, keeps the source and the report as
// container parts, and reports what it could not draw. The engine is the
// real slide wasm; the host is a recording fake (the open itself is the
// conformance spec's business).

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type {
  BundleHost,
  Diagnostic,
  Disposable,
  ImporterContribution,
  MutationInput,
  ObjectModelContribution,
} from "@paged-media/plugin-api";

import {
  activate,
  documentName,
  IMPORTER_ID,
  NOTES_PANEL_ID,
  REPORT_PART,
  SLIDES_PANEL_ID,
  SOURCE_PART,
} from "../src/activate";
import type { ImportReport } from "../src/engine";
import { SLIDE_KEY } from "../src/slides-model";

const FIXTURE = new URL("../../../slide-conformance/fixtures/placeholders.pptx", import.meta.url);

function recordingHost(supports: (f: string) => boolean) {
  const importers: ImporterContribution[] = [];
  const opened: Uint8Array[] = [];
  const parts = new Map<string, Uint8Array>();
  const diagnostics = new Map<string, Diagnostic[]>();
  const mutations: MutationInput[] = [];
  const objectModels: ObjectModelContribution[] = [];
  const schemaPanels: string[] = [];
  const noop = (): Disposable => ({ dispose() {} });
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports,
    contribute: {
      importer(c: ImporterContribution): Disposable {
        importers.push(c);
        return noop();
      },
      objectModel(c: ObjectModelContribution) {
        objectModels.push(c);
        return { ...noop(), changed() {} };
      },
      schemaPanel(c: { id: string }): Disposable {
        schemaPanels.push(c.id);
        return noop();
      },
    },
    nativeDocument: {
      async open(bytes: Uint8Array) {
        opened.push(bytes);
      },
    },
    // An empty document: the fingerprints the importer keeps are read here.
    document: {
      async mutate(m: MutationInput) {
        mutations.push(m);
        return { applied: true, createdId: null, pageIds: [] };
      },
      tree: async () => [],
      elementGeometry: async () => [],
      collection: async () => [],
      frameChain: async () => [],
      storyContent: async () => null,
    },
    parts: {
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
  return { host, importers, opened, parts, diagnostics, mutations, objectModels, schemaPanels };
}

describe("paged.slide importer", () => {
  it("declares a .pptx importer", () => {
    const r = recordingHost((f) => f === "contribute.importer@1");
    activate(r.host);
    expect(r.importers.map((i) => i.id)).toEqual([IMPORTER_ID]);
    expect(r.importers[0].extensions).toContain(".pptx");
  });

  it("opens the deck as a native document and keeps its source", async () => {
    const r = recordingHost((f) =>
      [
        "contribute.importer@1",
        "document.openNative@1",
        "storage.parts@1",
        "contribute.objectModel@1",
        "contribute.schemaPanel@1",
      ].includes(f),
    );
    activate(r.host);
    // ADR 323 — the property-row panels register next to the object model.
    expect(r.schemaPanels).toEqual([
      "media.paged.slide.panel.slide",
      "media.paged.slide.panel.transition",
      "media.paged.slide.panel.notes",
      "media.paged.slide.panel.placeholder",
      "media.paged.slide.panel.deck",
    ]);
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    await r.importers[0].import({ name: "placeholders.pptx", bytes, mimeType: "" });

    expect(r.opened).toHaveLength(1);
    // An IDML package: a zip whose first entry is the stored mimetype.
    const head = new TextDecoder().decode(r.opened[0].subarray(30, 38 + 43));
    expect(head).toContain("mimetype");
    expect(head).toContain("application/vnd.adobe.indesign-idml-package");

    expect(r.parts.get(SOURCE_PART)).toEqual(bytes);
    const report = JSON.parse(new TextDecoder().decode(r.parts.get(REPORT_PART))) as ImportReport;
    expect(report.slides.length).toBeGreaterThan(5);
    expect(report.slides.every((s) => s.pageId.length > 0)).toBe(true);
    expect(r.diagnostics.has("media.paged.slide/import")).toBe(true);
  });

  it("refuses honestly on a host that cannot open native documents", async () => {
    const r = recordingHost((f) => f === "contribute.importer@1");
    activate(r.host);
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    await r.importers[0].import({ name: "placeholders.pptx", bytes, mimeType: "" });
    expect(r.opened).toHaveLength(0);
    expect(r.diagnostics.get("media.paged.slide/import")?.[0]?.severity).toBe("error");
  });

  it("contributes the Slides and Notes panels where the page doors exist", () => {
    const panels: { id: string }[] = [];
    const noop = { dispose() {} };
    const host = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      supports: (f: string) =>
        ["contribute.panel@1", "render.snapshot@1", "viewport.pages@1"].includes(f),
      contribute: {
        panel(c: { id: string }) {
          panels.push(c);
          return noop;
        },
      },
      viewport: { activePage: () => null, onDidChangeActivePage: () => noop },
      document: {
        collection: async () => [],
        onDidChange: () => noop,
        onDidOpen: () => noop,
      },
    } as unknown as BundleHost;
    const handle = activate(host);
    expect(panels.map((p) => p.id)).toEqual([SLIDES_PANEL_ID, NOTES_PANEL_ID]);
    // A document that is not a deck keeps them out of the panel rail.
    expect(panels.map((p) => (p as { rail?: boolean }).rail)).toEqual([false, false]);
    handle.dispose();

    // Without the v70 doors the panels stay out.
    const without: { id: string }[] = [];
    activate({
      ...host,
      supports: (f: string) => f === "contribute.panel@1",
      contribute: { panel: (c: { id: string }) => (without.push(c), noop) },
    } as unknown as BundleHost);
    expect(without).toEqual([]);
  });

  it("puts the panels in the rail once the open document is a deck", async () => {
    const live = new Map<string, { rail?: boolean }>();
    const host = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      supports: (f: string) =>
        ["contribute.panel@1", "render.snapshot@1", "viewport.pages@1"].includes(f),
      contribute: {
        panel(c: { id: string; rail?: boolean }) {
          if (live.has(c.id)) throw new Error(`${c.id} registered twice`);
          live.set(c.id, c);
          return { dispose: () => live.delete(c.id) };
        },
      },
      viewport: { activePage: () => null, onDidChangeActivePage: () => ({ dispose() {} }) },
      document: {
        collection: async () => [
          {
            selfId: "p1",
            sizePt: [720, 405],
            pluginMetadata: [{ key: SLIDE_KEY, value: '{"v":1,"data":{"layout":"m1"}}' }],
          },
        ],
        onDidChange: () => ({ dispose() {} }),
        onDidOpen: () => ({ dispose() {} }),
      },
    } as unknown as BundleHost;
    const handle = activate(host);
    await vi.waitFor(() => expect(live.get(SLIDES_PANEL_ID)?.rail).toBe(true));
    expect(live.get(NOTES_PANEL_ID)?.rail).toBe(true);
    handle.dispose();
    expect(live.size).toBe(0);
  });

  it("names the document after the file", () => {
    expect(documentName("Q3 Review.final.pptx")).toBe("Q3 Review.final");
    expect(documentName("/decks/pitch.pptx")).toBe("pitch");
  });
});
