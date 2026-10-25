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

// File ▸ Import ▸ SVG… and File ▸ Export ▸ SVG (engine ADR 1016), the
// commands over a scripted client: the import plans and applies through
// the client (one write), reports the engine's losses and selects what it
// made; the exports hand the engine's SVG to the download door; the rows
// apply only with a document (and a selection).

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  buildSvgCommands,
  PAGED_FILE_EXPORT_SVG_PAGE,
  PAGED_FILE_EXPORT_SVG_SELECTION,
  PAGED_FILE_IMPORT_SVG,
  SVG_MENU_ITEMS,
  svgDocumentApplies,
  svgSelectionApplies,
  type SvgProblem,
} from "../../../src/svg-commands";

const GROUP = { kind: "group", id: "u9" };

function harness(selection: unknown[] = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  const selected: unknown[][] = [];
  const editor = {
    document: {
      handle: {
        pageCount: 1,
        pageIds: ["p1"],
        pageSizesPt: [[612, 792]],
        docId: "d",
      },
      sourceName: "Poster.idml",
    },
    camera: { camera: { scale: 0, tx: 0, ty: 0 }, viewportSize: [0, 0] },
    selection: {
      elementSelection: selection,
      setElementSelection: (ids: unknown[]) => selected.push(ids),
      setElementGeometry: () => {},
    },
    client: {
      async importSvg(pageId: string, bytes: Uint8Array) {
        calls.push(["importSvg", pageId, bytes.length]);
        return {
          plan: {
            mutation: { op: "batch", args: { ops: [] } },
            report: {
              items: 3,
              notes: [
                {
                  code: "filter",
                  severity: "dropped",
                  message: "a filter effect is left out",
                  count: 1,
                },
              ],
            },
            width: 10,
            height: 10,
            error: null,
          },
          reply: {
            kind: "mutationApplied",
            payload: { minted: [{ element: GROUP }], createdId: null },
          },
        };
      },
      async exportSvg(pageId: string, ids: unknown[]) {
        calls.push(["exportSvg", pageId, ids]);
        return { svg: "<svg/>", report: { items: 1, notes: [] } };
      },
      async elementGeometry(ids: unknown[]) {
        return ids.map((id) => ({ id, pageId: "p1", bounds: [0, 0, 1, 1] }));
      },
      async setElementSelection(ids: unknown[]) {
        return ids;
      },
    },
  };
  const rows: SvgProblem[][] = [];
  const saved: Array<{ name: string; mime: string; text: string }> = [];
  const commands = buildSvgCommands({
    report: (r) => rows.push([...r]),
    pickFile: async () =>
      new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "art.svg", {
        type: "image/svg+xml",
      }),
    save: (bytes, name, mime) =>
      saved.push({ name, mime, text: new TextDecoder().decode(bytes) }),
  });
  const run = (id: string) =>
    commands.find((c) => c.id === id)!.handler(editor as never, undefined);
  return { calls, selected, rows, saved, run };
}

describe("File ▸ Import ▸ SVG / Export ▸ SVG [editor-shell.import-svg-pdf-vectors]", () => {
  test("Import plans and applies once, reports the losses and selects the import", async () => {
    covers("command:paged.file.importSvg");
    const h = harness();
    await h.run(PAGED_FILE_IMPORT_SVG);
    expect(h.calls).toEqual([["importSvg", "p1", 41]]);
    expect(h.selected).toEqual([[GROUP]]);
    const messages = h.rows.flat().map((r) => `${r.severity}:${r.message}`);
    expect(
      messages.some(
        (m) => m.startsWith("warning:") && m.includes("a filter effect"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.startsWith("info:") && m.includes("3"))).toBe(
      true,
    );
  });

  test("Export page writes the engine's SVG under the document's name", async () => {
    covers("command:paged.file.exportSvgPage");
    const h = harness();
    await h.run(PAGED_FILE_EXPORT_SVG_PAGE);
    expect(h.calls).toEqual([["exportSvg", "p1", []]]);
    expect(h.saved).toEqual([
      { name: "Poster.svg", mime: "image/svg+xml", text: "<svg/>" },
    ]);
  });

  test("Export selection sends the selected items and needs some", async () => {
    covers("command:paged.file.exportSvgSelection");
    const h = harness([GROUP]);
    await h.run(PAGED_FILE_EXPORT_SVG_SELECTION);
    expect(h.calls).toEqual([["exportSvg", "p1", [GROUP]]]);
    expect(h.saved[0]!.name).toBe("Poster-selection.svg");
    const empty = harness([]);
    await empty.run(PAGED_FILE_EXPORT_SVG_SELECTION);
    expect(empty.calls).toEqual([]);
  });

  test("the rows apply only with a document, the selection row with a selection", () => {
    const doc = {
      document: { handle: { pageCount: 1 } },
      selection: { elementSelection: [] },
    };
    const none = { document: { handle: null } };
    expect(svgDocumentApplies(doc)).toBe(true);
    expect(svgDocumentApplies(none)).toBe(false);
    expect(svgSelectionApplies(doc)).toBe(false);
    expect(
      svgSelectionApplies({ ...doc, selection: { elementSelection: [GROUP] } }),
    ).toBe(true);
    expect(SVG_MENU_ITEMS.map((m) => m.path)).toEqual([
      "File/Import/SVG…",
      "File/Export/SVG (page)…",
      "File/Export/SVG (selection)…",
    ]);
  });
});
