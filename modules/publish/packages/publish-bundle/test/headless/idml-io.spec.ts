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

// The IDML importer and exporter File ▸ Open / File ▸ Export reach, on the
// REAL engine (headless). The editor backs the importer's door
// (`host.nativeDocument.open`) with "load these bytes as the active
// document"; here that door loads them into the headless engine, so the
// file round-trips through the engine's own IDML reader and writer.
//
// The document is IDML built in code (the shared test kit's gesture
// fixture: two pages, a frame, a group, a rotated frame, a locked frame, a
// master item, an open path), so no corpus is needed.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import type {
  ExporterContribution,
  ImporterContribution,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import {
  covers,
  gestureFixture,
  sceneElementIds,
  scenePageIds,
} from "@paged-media/test-kit";

import manifestJson from "../../manifest.json";
import { activate } from "../../src/activate";
import { IDML_EXPORTER_ID, IDML_IMPORTER_ID } from "../../src/io/idml";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let h: HeadlessHost;
let importer: ImporterContribution;
let exporter: ExporterContribution;
const errors: string[] = [];
let dispose: () => void;

/** The open document: its pages and its elements, by id. */
async function documentShape(): Promise<{
  pages: string[];
  elements: string[];
}> {
  const send = (
    m: Parameters<HeadlessHost["host"]["editor"]["client"]["send"]>[0],
  ) => h.host.editor.client.send(m);
  return {
    pages: await scenePageIds(send as never),
    elements: (await sceneElementIds(send as never))
      .map((id) => `${id.kind}:${id.id}`)
      .sort(),
  };
}

beforeAll(async () => {
  h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR, console: silent });
  // The editor's arrangement: the bundle on a host whose native-document
  // door loads the bytes as the active document.
  const handle = createBundleHost(
    () => h.host.editor,
    manifestJson as PluginManifest,
    {
      console: {
        ...silent,
        error: (...a: unknown[]) => void errors.push(a.join(" ")),
      },
      nativeDocument: {
        readModel: async () => null,
        readComposition: async () => null,
        listParts: async () => [],
        open: async (bytes) => {
          await h.load(bytes);
        },
      },
    },
  );
  const bundle = activate(handle.host);
  dispose = () => {
    bundle.dispose();
    handle.dispose();
  };
  importer = h.importersContributed().find((c) => c.id === IDML_IMPORTER_ID)!;
  exporter = h.exportersContributed().find((c) => c.id === IDML_EXPORTER_ID)!;
}, 60_000);

afterAll(() => {
  dispose?.();
  h?.dispose();
});

describe("the IDML importer and exporter on the real engine", () => {
  it("File ▸ Open of an .idml opens it as the active document", async () => {
    covers("importer:media.paged.publish.importer.idml");
    await h.newBlank(300, 300);
    expect((await documentShape()).pages).toHaveLength(1);
    await importer.import({
      name: "targets.idml",
      bytes: gestureFixture("targets"),
      mimeType: "application/vnd.adobe.indesign-idml-package",
    });
    const shape = await documentShape();
    // The fixture's two pages and its elements, not the blank page.
    expect(shape.pages).toHaveLength(2);
    expect(shape.elements.length).toBeGreaterThanOrEqual(8);
    expect(errors).toEqual([]);
  });

  it("a file the engine cannot read leaves the open document as it was, and says so", async () => {
    covers("importer:media.paged.publish.importer.idml");
    const before = await documentShape();
    await importer.import({
      name: "broken.idml",
      bytes: new Uint8Array([0x50, 0x4b, 0, 0, 1, 2, 3]),
      mimeType: "",
    });
    expect(await documentShape()).toEqual(before);
    expect(errors.some((e) => e.includes("broken.idml"))).toBe(true);
    errors.length = 0;
  });

  it("File ▸ Export writes an IDML package that opens again as the same document", async () => {
    covers(
      "exporter:media.paged.publish.exporter.idml",
      "importer:media.paged.publish.importer.idml",
    );
    const before = await documentShape();
    const out = await exporter.export();
    expect(out).not.toBeNull();
    expect(out!.fileName).toMatch(/\.idml$/);
    // A ZIP whose first entry is the IDML mimetype.
    const head = new TextDecoder().decode(out!.bytes.subarray(0, 80));
    expect(head.startsWith("PK")).toBe(true);
    expect(head).toContain("mimetype");
    expect(new TextDecoder().decode(out!.bytes)).toContain(
      "application/vnd.adobe.indesign-idml-package",
    );
    await h.newBlank(100, 100);
    await importer.import({
      name: out!.fileName,
      bytes: out!.bytes,
      mimeType: "",
    });
    expect(await documentShape()).toEqual(before);
    expect(errors).toEqual([]);
  });
});
