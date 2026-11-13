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

// The document map's lenses, their pure parts (editor ADR "Page lenses and
// semantic zoom"): which lenses show, the one search, the headings in
// document order, the link problems by host frame, the issues grouped by
// page and the placed records.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import type {
  ElementId,
  LinkSummary,
  PreflightFinding,
} from "@paged-media/client";

import {
  headingsOf,
  issuesByPage,
  lensesFor,
  linkProblemHosts,
  matches,
  pageLabel,
  recordsOf,
} from "../../src/panels/cockpit/page-lenses";

const rect = (id: string) => ({ kind: "rectangle", id }) as ElementId;

describe("the page lenses", () => {
  test("Data shows only with a data binding", () => {
    covers("panel:paged.document-map");
    expect(lensesFor(false)).toEqual([
      "pages",
      "structure",
      "layers",
      "issues",
    ]);
    expect(lensesFor(true)).toEqual([
      "pages",
      "structure",
      "layers",
      "issues",
      "data",
    ]);
  });

  test("the search matches any of an entry's words, ignoring case; empty matches all", () => {
    expect(matches("", "anything")).toBe(true);
    expect(matches("  ", null)).toBe(true);
    expect(matches("intro", "Chapter 1", "Introduction")).toBe(true);
    expect(matches("IV", "iv")).toBe(true);
    expect(matches("x", "Chapter 1", null, undefined)).toBe(false);
    expect(pageLabel(3, { name: "iv" })).toBe("iv");
    expect(pageLabel(3, { name: "" })).toBe("4");
    expect(pageLabel(3, undefined)).toBe("4");
  });

  test("headings: the numbered ones with a page, in page order", () => {
    const numbering = {
      "h:s1:2": { text: "Second", level: 2, pageId: "p2", pageNumber: 2 },
      "h:s1:0": { text: "First", level: 1, pageId: "p1", pageNumber: 1 },
      "fig:1": { text: "Figure", level: 0, pageId: "p1", pageNumber: 1 },
      "h:s9:0": { text: "Nowhere", level: 1, pageId: null, pageNumber: 0 },
    };
    expect(headingsOf(numbering, ["p1", "p2"])).toEqual([
      { id: "h:s1:0", text: "First", level: 1, pageIndex: 0 },
      { id: "h:s1:2", text: "Second", level: 2, pageIndex: 1 },
    ]);
  });

  test("link problems: missing and low-resolution images by their host frames", () => {
    const links = [
      { status: "missing", hostKind: "Rectangle", hostSelfId: "u1" },
      { status: "ok", hostKind: "Oval", hostSelfId: "u2", effectivePpi: 96 },
      {
        status: "ok",
        hostKind: "Polygon",
        hostSelfId: "u3",
        effectivePpi: 300,
      },
      { status: "missing", hostKind: "Group", hostSelfId: "u4" },
    ] as unknown as LinkSummary[];
    expect(linkProblemHosts(links)).toEqual({
      missing: [rect("u1")],
      lowRes: [{ kind: "oval", id: "u2" } as ElementId],
    });
  });

  test("issues group by page, in page order; what has no page is left out", () => {
    const located = [
      {
        kind: "overset" as const,
        id: { kind: "textFrame", id: "t1" } as ElementId,
        pageId: "p3",
      },
      { kind: "missingLinks" as const, id: rect("u1"), pageId: "p1" },
      { kind: "lowRes" as const, id: rect("u2"), pageId: null },
    ];
    const preflight = [
      { code: "x", severity: "error", message: "m", pageIndex: 2 },
      { code: "y", severity: "warning", message: "n", pageIndex: 7 },
    ] as unknown as PreflightFinding[];
    const pages = issuesByPage(["p1", "p2", "p3"], located, preflight);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 2]);
    expect(pages[0]!.missingLinks).toEqual([rect("u1")]);
    expect(pages[1]!.overset).toEqual([{ kind: "textFrame", id: "t1" }]);
    expect(pages[1]!.preflight).toHaveLength(1);
  });

  test("records: each placed record with the page items it landed in", () => {
    expect(
      recordsOf([
        { address: "textFrame:u3", record: 1 },
        { address: "rectangle:u4", record: 0 },
        { address: "textFrame:u5", record: 1 },
        { address: "story:s1/0-4", record: 2 },
        { address: "textFrame:u6" },
      ]),
    ).toEqual([
      { record: 0, items: [rect("u4")] },
      {
        record: 1,
        items: [
          { kind: "textFrame", id: "u3" },
          { kind: "textFrame", id: "u5" },
        ],
      },
    ]);
  });
});
