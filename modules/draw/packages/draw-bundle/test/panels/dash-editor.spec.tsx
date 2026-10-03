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

// @vitest-environment jsdom

// The STROKE DASHES section of the Path Options panel, RENDERED (jsdom)
// against the real engine. The sentence it has to prove: the pairs TYPED
// are the dash the engine HOLDS, and the dash the engine holds is what
// the section SHOWS for the selection. So every test types, applies,
// and reads `frameStrokeDashArray` back out of the document; one undo
// restores; and the section follows the selected path — without
// throwing away what was typed on a reload that changed nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  dashLengthsOf,
  dashOptionsFromLengths,
  dashPatternLabel,
  drawBundle,
  hiddenPairsNote,
  makePathOptionsPanel,
  openPathOptions,
  strokePanel,
  DASH_SECTION_NOTE,
  PATH_OPTIONS_DEFAULTS,
  PATH_OPTIONS_PANEL_ID,
} from "../../src";
import { openHost } from "../conformance/host";
import {
  drive,
  mountPanel,
  panelDocument,
  poly,
  squareItem,
  teardownPanels,
  type MountedPanel,
} from "./harness";

const A = poly("da");
const B = poly("db");
const SEEDS = squareItem("da", 60, 60, 80) + squareItem("db", 200, 60, 80);

const field = (name: string) => `[data-draw-pathopts-field="${name}"]`;
const toggle = (name: string) => `[data-draw-pathopts-toggle="${name}"]`;
const APPLY = `[data-draw-pathopts-apply="dash"]`;
const HEADER = `[data-draw-pathopts-header="dash"]`;

const valueOf = (panel: MountedPanel, name: string): string =>
  panel.get<HTMLInputElement>(field(name)).value;

async function dashOf(h: HeadlessHost, id: ElementId): Promise<number[] | null> {
  const props = await h.host.document.elementProperties(id);
  const e = props?.entries.find((x) => x.path === "frameStrokeDashArray");
  return e?.value?.type === "lengths" ? e.value.value : null;
}

async function setDash(h: HeadlessHost, id: ElementId, lengths: number[]): Promise<void> {
  const out = await h.host.document.mutate({
    op: "setElementProperty",
    args: { elementId: id, path: "frameStrokeDashArray", value: { type: "lengths", value: lengths } },
  });
  if (!out.applied) throw new Error("dash setup refused");
}

describe("the pure half", () => {
  it("dashLengthsOf: unticked is SOLID; pair 1 always, later pairs only when not 0/0", () => {
    const d = PATH_OPTIONS_DEFAULTS.dash;
    expect(dashLengthsOf({ ...d, dashed: false })).toEqual([]);
    expect(dashLengthsOf({ ...d, dashed: true })).toEqual([6, 3]);
    expect(
      dashLengthsOf({ dashed: true, dash1: 4, gap1: 2, dash2: 0, gap2: 0, dash3: 1, gap3: 2 }),
    ).toEqual([4, 2, 1, 2]);
    expect(
      dashLengthsOf({ dashed: true, dash1: 0, gap1: 0, dash2: 0, gap2: 0, dash3: 0, gap3: 0 }),
    ).toEqual([]);
    // A negative length is not a length.
    expect(
      dashLengthsOf({ dashed: true, dash1: -3, gap1: 2, dash2: 0, gap2: 0, dash3: 0, gap3: 0 }),
    ).toEqual([0, 2]);
  });

  it("dashOptionsFromLengths: an odd array repeats to even; pairs past three are COUNTED, not dropped silently", () => {
    expect(dashOptionsFromLengths([5]).options).toMatchObject({ dashed: true, dash1: 5, gap1: 5 });
    const four = dashOptionsFromLengths([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(four.hiddenPairs).toBe(1);
    expect(four.options).toMatchObject({ dash3: 5, gap3: 6 });
    expect(dashOptionsFromLengths([]).options.dashed).toBe(false);
    expect(dashOptionsFromLengths(null).options.dashed).toBe(false);
    expect(dashPatternLabel([])).toBe("Solid");
    expect(dashPatternLabel([6, 3])).toBe("6 · 3 pt");
  });

  it("the Stroke panel's Dashes readout points at the editor (the schema cannot bind a vector)", () => {
    const section = strokePanel.schema.sections.find((s) => s.title === "Dashes")!;
    const text = (section.rows[0]!.props as { text: string }).text;
    expect(text).toContain("Draw ▸ Stroke ▸ Dashes…");
  });
});

describe("Stroke dashes — rendered against the engine", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(panelDocument(SEEDS));
  });
  afterEach(() => teardownPanels(h));

  it("SHOWS the selected path's own dash", async () => {
    await setDash(h, A, [6, 3, 1, 3]);
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    await drive(() => h.host.selection.set([A]), panel.work);
    expect(panel.get<HTMLInputElement>(toggle("dash.dashed")).checked).toBe(true);
    expect(["dash1", "gap1", "dash2", "gap2", "dash3", "gap3"].map((k) => valueOf(panel, `dash.${k}`))).toEqual(
      ["6", "3", "1", "3", "0", "0"],
    );
    expect(panel.get("[data-draw-pathopts-dash-pattern]").textContent).toBe("6 · 3 · 1 · 3 pt");
    expect(panel.get("[data-draw-pathopts-dash-note]").textContent).toBe(DASH_SECTION_NOTE);
    expect(panel.count("[data-draw-pathopts-dash-hidden]")).toBe(0);
  });

  it("the pairs TYPED are the dash the engine holds — for every selected path, in ONE undo step", async () => {
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    await drive(() => h.host.selection.set([A, B]), panel.work);
    expect(panel.get(APPLY).textContent).toBe("Apply to 2 paths");
    await panel.click(toggle("dash.dashed"));
    panel.change(field("dash.dash1"), "8");
    panel.change(field("dash.gap1"), "2");
    panel.change(field("dash.dash2"), "1");
    panel.change(field("dash.gap2"), "2");
    panel.reset();
    await panel.click(APPLY);
    expect(await dashOf(h, A)).toEqual([8, 2, 1, 2]);
    expect(await dashOf(h, B)).toEqual([8, 2, 1, 2]);
    expect(panel.work.mutations).toEqual([{ op: "batch", ops: 2 }]);
    expect(panel.work.count("log.warn")).toBe(0);
    await drive(() => h.host.document.undo(), panel.work);
    expect(await dashOf(h, A)).toEqual([]);
    expect(await dashOf(h, B)).toEqual([]);
  });

  it("unticking Dashed writes a SOLID stroke (the empty array)", async () => {
    await setDash(h, A, [4, 4]);
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    await drive(() => h.host.selection.set([A]), panel.work);
    await panel.click(toggle("dash.dashed"));
    expect(panel.get("[data-draw-pathopts-dash-pattern]").textContent).toBe("Solid");
    expect(panel.get<HTMLInputElement>(field("dash.dash1")).disabled).toBe(true);
    await panel.click(APPLY);
    expect(await dashOf(h, A)).toEqual([]);
  });

  it("FOLLOWS the selection — and a reload that changes neither the path nor its dash keeps what was typed", async () => {
    await setDash(h, A, [6, 3]);
    await setDash(h, B, [2, 1]);
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    await drive(() => h.host.selection.set([A]), panel.work);
    expect(valueOf(panel, "dash.dash1")).toBe("6");
    // Typed, not applied…
    panel.change(field("dash.dash1"), "11");
    // …and a document change somewhere else reloads the panel: kept.
    await drive(() => setDash(h, poly("p0"), [1, 1]), panel.work);
    expect(valueOf(panel, "dash.dash1")).toBe("11");
    // A different path selected: ITS dash.
    await drive(() => h.host.selection.set([B]), panel.work);
    expect(valueOf(panel, "dash.dash1")).toBe("2");
    expect(valueOf(panel, "dash.gap1")).toBe("1");
    // The path's dash changed under the panel (an undo): followed again.
    await drive(() => setDash(h, B, [9, 9]), panel.work);
    expect(valueOf(panel, "dash.dash1")).toBe("9");
  });

  it("a dash with MORE than three pairs says so, and Apply writes the three it shows", async () => {
    await setDash(h, A, [1, 2, 3, 4, 5, 6, 7, 8]);
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    await drive(() => h.host.selection.set([A]), panel.work);
    expect(panel.get("[data-draw-pathopts-dash-hidden]").textContent).toBe(hiddenPairsNote(1));
    await panel.click(APPLY);
    expect(await dashOf(h, A)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the menu's “Draw ▸ Stroke ▸ Dashes…” RAISES the panel at this section and writes nothing", async () => {
    const panel = await mountPanel(h, makePathOptionsPanel);
    await drive(() => h.host.selection.set([A]), panel.work);
    const opened: string[] = [];
    const raising = new Proxy(h.host, {
      get(target, prop, receiver) {
        if (prop === "supports") {
          return (f: string) => (f === "shell.openPanel@1" ? true : target.supports(f));
        }
        if (prop === "shell") {
          return { ...target.shell, openPanel: (id: string) => void opened.push(id) };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as BundleHost;
    panel.reset();
    await drive(() => openPathOptions(raising, "dash"), panel.work);
    expect(opened).toEqual([PATH_OPTIONS_PANEL_ID]);
    expect(panel.attr("[data-draw-pathopts-panel]", "data-draw-pathopts-panel")).toBe("dash");
    expect(panel.work.mutations).toEqual([]);
    expect(await dashOf(h, A)).toEqual([]);
  });

  it("the reload budget holds: one selected path is still ONE property read (stroke AND dash)", async () => {
    const panel = await mountPanel(h, makePathOptionsPanel);
    const cost = await panel.costOf(() => h.host.selection.set([A]));
    expect(cost.reads).toBe(1);
    expect(panel.work.count("document.elementProperties")).toBe(1);
  });
});
