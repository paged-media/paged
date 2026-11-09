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

// [sheet.workbook-editor] paged.sheet as the workbook editor of the
// workbook door (extensions ADR 1102), on the REAL engine: a workbook
// another bundle hands over opens in a detached session; its grid is the
// sheet's grid with the consumer's ranges tinted; an edit made in the grid
// comes back as XLSX bytes the engine reads again; nothing touches the
// document (no subscription, no part, no blob). Skipped without the wasm.

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import {
  createWorkbookEditorRegistry,
  createWorkbooksSurface,
} from "@paged-media/plugin-sdk";

import { WORKBOOK_EDITOR_ID, workbookEditor } from "../src";
import { ENGINE_BUILT, authorWorkbook, readCell } from "./perf/workload";

/** A host that records every document, parts and blob door it is asked
 *  for: a detached workbook must ask none of them. */
function recordingHost() {
  const touched: string[] = [];
  const door = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, key) {
          touched.push(`${name}.${String(key)}`);
          return () => ({ dispose() {} });
        },
      },
    );
  const host = {
    manifest: { id: "media.paged.sheet" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: () => false,
    document: door("document"),
    parts: door("parts"),
    blob: door("blob"),
    storage: door("storage"),
    comments: door("comments"),
  } as unknown as BundleHost;
  return { host, touched };
}

function byData(tree: ReactTestRenderer, key: string, value?: string) {
  return tree.root.findAll(
    (n) =>
      typeof n.type === "string" &&
      n.props[key] !== undefined &&
      (value === undefined || n.props[key] === value),
  );
}

const at = (x: number, y: number) =>
  ({
    clientX: x,
    clientY: y,
    preventDefault() {},
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  }) as never;

describe.skipIf(!ENGINE_BUILT)(
  "[sheet.workbook-editor] the workbook door's editor",
  () => {
    setDefaultTimeout(60_000);

    it("edits a handed-over workbook on the sheet's grid and gives the bytes back", async () => {
      const xlsx = await authorWorkbook(4, 2, (r, c) =>
        r === 0 ? (c === 0 ? "" : "North") : c === 0 ? `Q${r}` : String(r * 10),
      );
      const { host, touched } = recordingHost();
      const registry = createWorkbookEditorRegistry();
      registry.register("media.paged.sheet", workbookEditor(host));
      const door = createWorkbooksSurface(registry, (d) => d);
      const session = await door.open({
        xlsx,
        name: "chart1.xlsx",
        ranges: [
          {
            sheet: "Sheet1",
            startRow: 0,
            startCol: 1,
            endRow: 0,
            endCol: 1,
            role: "name",
          },
          {
            sheet: "Sheet1",
            startRow: 1,
            startCol: 0,
            endRow: 3,
            endCol: 0,
            role: "category",
          },
          {
            sheet: "Sheet1",
            startRow: 1,
            startCol: 1,
            endRow: 3,
            endCol: 1,
            role: "value",
          },
        ],
      });
      expect(session.editor).toBe(WORKBOOK_EDITOR_ID);
      // Unedited, the consumer's own bytes come back.
      expect(session.changed()).toBe(false);
      expect(session.xlsx()).toBe(xlsx);

      let tree!: ReactTestRenderer;
      act(() => {
        tree = create(
          createElement(session.Surface, { width: 400, height: 300 }),
        );
      });
      // The sheet's grid, without the panel's find and notes.
      expect(byData(tree, "data-grid-svg-root")).toHaveLength(1);
      expect(byData(tree, "data-grid-find")).toHaveLength(0);
      expect(byData(tree, "data-grid-honesty")).toHaveLength(0);
      const inner = byData(tree, "data-grid-svg-root")[0]!.props
        .dangerouslySetInnerHTML.__html as string;
      expect(inner).toContain(">North</text>");
      // Seven cells read by the chart, tinted by role.
      const rects = byData(tree, "data-grid-ranges")[0]!.findAllByType("rect");
      expect(rects).toHaveLength(7);
      const fills = new Set(rects.map((r) => r.props.fill as string));
      expect(fills.size).toBe(3);

      // Double-click the last value cell (B4) and type into it.
      let heard = 0;
      session.onDidChange(() => heard++);
      const b4 = rects.at(-1)!.props;
      act(() => {
        byData(tree, "data-grid-svg-root")[0]!.props.onDoubleClick(
          at(b4.x + b4.width / 2, b4.y + b4.height / 2),
        );
      });
      const editor = () => byData(tree, "data-grid-editor")[0]!;
      expect(editor().props.value).toBe("30");
      act(() => editor().props.onChange({ target: { value: "9.25" } }));
      act(() =>
        editor().props.onKeyDown({
          key: "Enter",
          shiftKey: false,
          preventDefault() {},
        }),
      );
      expect(heard).toBeGreaterThan(0);
      expect(session.changed()).toBe(true);
      const edited = session.xlsx();
      expect(edited).not.toBe(xlsx);
      expect(await readCell(edited, 3, 1)).toBe("9.25");
      expect(await readCell(edited, 0, 1)).toBe("North");

      act(() => tree.unmount());
      session.close();
      // Closed, the last bytes stay.
      expect(await readCell(session.xlsx(), 3, 1)).toBe("9.25");
      // Nothing reached the document.
      expect(touched).toEqual([]);
    });

    it("refuses bytes that are not a workbook", async () => {
      const { host } = recordingHost();
      await expect(
        workbookEditor(host).open({ xlsx: new Uint8Array([0x50, 0x4b, 3, 4]) }),
      ).rejects.toThrow();
    });
  },
);
