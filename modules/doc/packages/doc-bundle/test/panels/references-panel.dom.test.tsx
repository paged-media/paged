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

// Doc ADR 612 — the References panel: each section's button runs its one
// action with what was typed or picked; the page setup reads the section's
// page and writes it back; and the page setup's writes.

import { afterEach, describe, expect, it } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";
import * as React from "react";

import {
  makeReferencesPanel,
  type PageSetup,
  type ReferencesActions,
} from "../../src/panels/references-panel";
import { pageSetupOps } from "../../src/word/references";

afterEach(() => cleanup());

const SETUP: PageSetup = {
  widthPt: 612,
  heightPt: 792,
  marginTopPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
  marginRightPt: 72,
  columns: 1,
};

function recorder() {
  const calls: unknown[][] = [];
  const yes = (name: string) =>
    (async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return true;
    }) as never;
  const actions: ReferencesActions = {
    insertBookmark: yes("bookmark"),
    insertField: yes("field"),
    insertIndexEntry: yes("index"),
    insertNote: yes("note"),
    insertCrossReference: yes("xref"),
    applyPageSetup: yes("pageSetup"),
    targets: async () => [
      { label: "Results", target: { bookmark: "Results" } },
      { label: "Introduction", target: { storyId: "docx_s0", paragraph: 5 } },
    ],
    pageSetup: async () => SETUP,
  };
  return { calls, actions };
}

async function mounted(actions: ReferencesActions) {
  const { component: C } = makeReferencesPanel(actions);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<C paged={undefined as never} api={undefined as never} />);
  });
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return view.container;
}

const q = (root: HTMLElement, sel: string) =>
  root.querySelector(sel) as HTMLInputElement;

describe("the References panel", () => {
  it("adds a bookmark, a field and an index entry from what was typed", async () => {
    covers("panel:media.paged.doc.panel.references");
    const { calls, actions } = recorder();
    const root = await mounted(actions);
    const add = q(root, '[data-ref-action="bookmark"]');
    expect(add.disabled).toBe(true);
    fireEvent.change(q(root, '[data-ref-input="bookmark"]'), {
      target: { value: "Totals" },
    });
    fireEvent.change(q(root, '[data-ref-input="field"]'), {
      target: { value: " SECTIONPAGES " },
    });
    fireEvent.change(q(root, '[data-ref-input="indexEntry"]'), {
      target: { value: "Fruit: Pears" },
    });
    await act(async () => {
      fireEvent.click(q(root, '[data-ref-action="bookmark"]'));
      fireEvent.click(q(root, '[data-ref-action="field"]'));
      fireEvent.click(q(root, '[data-ref-action="indexEntry"]'));
    });
    expect(calls).toEqual([
      ["bookmark", "Totals"],
      ["field", "SECTIONPAGES"],
      ["index", ["Fruit", "Pears"]],
    ]);
    expect(q(root, '[data-ref-outcome="field"]').textContent).toBeTruthy();
  });

  it("inserts a cross-reference to the picked heading as its page number", async () => {
    const { calls, actions } = recorder();
    const root = await mounted(actions);
    fireEvent.change(q(root, '[data-ref-input="target"]'), {
      target: { value: "1" },
    });
    fireEvent.change(q(root, '[data-ref-input="referTo"]'), {
      target: { value: "pageNumber" },
    });
    await act(async () => {
      fireEvent.click(q(root, '[data-ref-action="crossReference"]'));
    });
    expect(calls).toEqual([
      ["xref", { storyId: "docx_s0", paragraph: 5 }, "pageNumber"],
    ]);
  });

  it("inserts a footnote and an endnote with their text", async () => {
    const { calls, actions } = recorder();
    const root = await mounted(actions);
    fireEvent.change(q(root, '[data-ref-input="note"]'), {
      target: { value: "See the annex." },
    });
    await act(async () => {
      fireEvent.click(q(root, '[data-ref-action="footnote"]'));
      fireEvent.click(q(root, '[data-ref-action="endnote"]'));
    });
    expect(calls).toEqual([
      ["note", false, "See the annex."],
      ["note", true, "See the annex."],
    ]);
  });

  it("turns the page to landscape, changes a margin and applies it", async () => {
    const { calls, actions } = recorder();
    const root = await mounted(actions);
    fireEvent.click(q(root, '[data-ref-action="orientation"]'));
    fireEvent.change(q(root, '[data-ref-input="marginLeftPt"]'), {
      target: { value: "36" },
    });
    await act(async () => {
      fireEvent.click(q(root, '[data-ref-action="pageSetup"]'));
    });
    expect(calls).toEqual([
      [
        "pageSetup",
        { ...SETUP, widthPt: 792, heightPt: 612, marginLeftPt: 36 },
      ],
    ]);
  });
});

describe("a page setup's writes", () => {
  it("size the page, set its margins and columns, and put the frame on the margin box", () => {
    const ops = pageSetupOps("docx_p0", "docx_f0", {
      ...SETUP,
      columns: 2,
    }) as Array<{ op: string; args: Record<string, unknown> }>;
    expect(ops[0]).toEqual({
      op: "resizePage",
      args: { pageId: "docx_p0", bounds: [0, 0, 792, 612] },
    });
    expect(ops.find((o) => o.op === "resizeFrame")!.args.bounds).toEqual([
      72, 72, 720, 540,
    ]);
    expect(ops.at(-1)!.args).toMatchObject({
      address: "frame:docx_f0",
      path: "textFrameColumnCount",
      value: { type: "length", value: 2 },
    });
  });
});
