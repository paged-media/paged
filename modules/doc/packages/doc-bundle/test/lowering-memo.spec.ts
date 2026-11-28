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

// The lowering memo answers for a document, not for a label: an import's
// label names `<story>/source.docx`, so two documents can carry the same
// label over different bytes. Only a content-addressed part's label is an
// identity of its own.

import { describe, expect, it } from "bun:test";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import { type DocState, readLowered } from "../src/doc-state";

const frame = { kind: "textFrame", id: "docx_f0" } as unknown as ElementId;

function stateOf(data: DocState["data"]): DocState {
  return { frame, data, labelText: JSON.stringify({ v: 1, data }) };
}

/** A host holding the given parts, counting the reads of each. */
function hostOf(parts: Record<string, string>) {
  const reads: string[] = [];
  const host = {
    parts: {
      read: async (path: string) => {
        reads.push(path);
        const text = parts[path];
        if (text === undefined) throw new Error(`no part ${path}`);
        return new TextEncoder().encode(text);
      },
    },
  } as unknown as BundleHost;
  return { host, reads };
}

const lowering = (marker: string) =>
  JSON.stringify({ story: { blocks: [] }, diagnostics: [], marker });
const markerOf = (ir: unknown) => (ir as { marker: string }).marker;

describe("[plugin-doc.read-path] the lowering memo", () => {
  it("does not hand one document's lowering to another with the same label", async () => {
    const data = {
      part: "docx/source.docx",
      lowered: "docx/lowered.json",
      blocks: 0,
      fileName: "report.docx",
    };
    const first = hostOf({
      "docx/source.docx": "bytes of the first file",
      "docx/lowered.json": lowering("first"),
    });
    const second = hostOf({
      "docx/source.docx": "bytes of the second file",
      "docx/lowered.json": lowering("second"),
    });
    const a = stateOf(data);
    const b = stateOf(data);
    expect(a.labelText).toBe(b.labelText);

    expect(markerOf(await readLowered(first.host, a))).toBe("first");
    expect(markerOf(await readLowered(second.host, b))).toBe("second");
    // The same bytes under the same label are remembered: the cache part
    // is not read a second time.
    first.reads.length = 0;
    second.reads.length = 0;
    expect(markerOf(await readLowered(second.host, b))).toBe("second");
    expect(second.reads).toEqual(["docx/source.docx"]);
    expect(markerOf(await readLowered(first.host, a))).toBe("first");
  });

  it("answers a content-addressed label without reading a part", async () => {
    const hash = "ab".repeat(32);
    const data = {
      part: `sources/${hash}.docx`,
      lowered: `lowered/${hash}.json`,
      blocks: 0,
    };
    const { host, reads } = hostOf({
      [`sources/${hash}.docx`]: "addressed bytes",
      [`lowered/${hash}.json`]: lowering("addressed"),
    });
    const s = stateOf(data);
    expect(markerOf(await readLowered(host, s))).toBe("addressed");
    expect(reads).toEqual([`lowered/${hash}.json`]);
    reads.length = 0;
    expect(markerOf(await readLowered(host, s))).toBe("addressed");
    expect(reads).toEqual([]);
  });
});
