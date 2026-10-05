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

import { describe, expect, it } from "vitest";

import type { BundleHost, Diagnostic, Disposable, ImporterContribution } from "@paged-media/plugin-api";

import { activate, documentName, IMPORTER_ID, REPORT_PART, SOURCE_PART } from "../src/activate";
import type { ImportReport } from "../src/engine";

const FIXTURE = new URL("../../../slide-conformance/fixtures/placeholders.pptx", import.meta.url);

function recordingHost(supports: (f: string) => boolean) {
  const importers: ImporterContribution[] = [];
  const opened: Uint8Array[] = [];
  const parts = new Map<string, Uint8Array>();
  const diagnostics = new Map<string, Diagnostic[]>();
  const noop = (): Disposable => ({ dispose() {} });
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports,
    contribute: {
      importer(c: ImporterContribution): Disposable {
        importers.push(c);
        return noop();
      },
    },
    nativeDocument: {
      async open(bytes: Uint8Array) {
        opened.push(bytes);
      },
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
  return { host, importers, opened, parts, diagnostics };
}

describe("paged.slide importer", () => {
  it("declares a .pptx importer", () => {
    const r = recordingHost((f) => f === "contribute.importer@1");
    activate(r.host);
    expect(r.importers.map((i) => i.id)).toEqual([IMPORTER_ID]);
    expect(r.importers[0].extensions).toContain(".pptx");
  });

  it("opens the deck as a native document and keeps its source", async () => {
    const r = recordingHost(() => true);
    activate(r.host);
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

  it("names the document after the file", () => {
    expect(documentName("Q3 Review.final.pptx")).toBe("Q3 Review.final");
    expect(documentName("/decks/pitch.pptx")).toBe("pitch");
  });
});
