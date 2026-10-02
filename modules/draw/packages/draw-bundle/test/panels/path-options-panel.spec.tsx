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

// The PATH OPTIONS panel, RENDERED (jsdom) against the real engine.
//
// What it has to prove is one sentence: A NUMBER TYPED INTO A FIELD
// REACHES THE ENGINE. So every behaviour test types into the form,
// clicks the section's button, and reads the result back out of the
// DOCUMENT — the offset square's bounds, the simplified path's anchor
// count, the inserted arc's anchor table — and then undoes ONCE and
// requires the document to be what it was.
//
// Around that: the "…" commands RAISE the panel at their section and
// mutate nothing (and degrade to applying on a host with no panel door);
// the same command run bare repeats the values last APPLIED; a draft
// survives a reload, an Apply in another section, and an unmount; and
// the reload budget — this panel keeps no records, so a reload reads at
// most the selected path's own stroke.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  arcTablesFor,
  lastUsedPathOptions,
  lastUsedPayload,
  makePathOptionsPanel,
  openPathOptions,
  ownStrokeLabel,
  pathOptionsFocusOf,
  showPathOptions,
  INSERT_ARC_COMMAND_ID,
  OFFSET_JOIN_NOTE,
  OFFSET_PATH_COMMAND_ID,
  PATH_OPTIONS_COMMANDS,
  PATH_OPTIONS_DEFAULTS,
  PATH_OPTIONS_PANEL_ID,
  PATH_OPTIONS_PANEL_NOTE,
  PATH_OPTION_SECTIONS,
  PATH_OPTION_SECTION_TITLES,
} from "../../src";
import { MENU_COMMAND_PREFIX, MENU_ENTRIES } from "../../src/menu";
import { pathItem } from "../fixtures/build-idml";
import { openHost } from "../conformance/host";
import {
  drive,
  leafIds,
  lineItem,
  mountContributed,
  mountPanel,
  panelDocument,
  poly,
  selectionBurst,
  squareItem,
  teardownPanels,
  unmountAll,
  PLAIN_LEAVES,
  type MountedPanel,
} from "./harness";

const PANEL = "[data-draw-pathopts-panel]";

// THE SEEDS, all in the page's upper half:
//   · `sq`  — a closed 100 pt square at (60, 60): the Offset target;
//   · `wob` — an open zig-zag, 8 pt of wobble: the Simplify target;
//   · `ln`  — an open horizontal line at y = 300: the Outline target.
const SQ = poly("sq");
const WOB = poly("wob");
const LN = poly("ln");
const SEEDS =
  squareItem("sq", 60, 60, 100) +
  pathItem("Polygon", "wob", "80 250 88 490", true, [
    { a: [250, 80] },
    { a: [290, 88] },
    { a: [330, 80] },
    { a: [370, 88] },
    { a: [410, 80] },
    { a: [450, 88] },
    { a: [490, 80] },
  ]) +
  lineItem("ln", 250, 300, 450, 300);
const PRISTINE = 3 + PLAIN_LEAVES;

/** `[minX, minY, maxX, maxY]` over anchors and handles. */
function boxOf(table: PathAnchorsResult): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of table.anchors) {
    for (const p of [a.anchor, a.left, a.right]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return [minX, minY, maxX, maxY];
}

const shapeOf = (t: PathAnchorsResult | null) =>
  t && {
    anchors: t.anchors.map((a) => ({
      anchor: a.anchor,
      left: a.left,
      right: a.right,
    })),
    subpathStarts: t.subpathStarts,
    subpathOpen: t.subpathOpen,
  };

const field = (name: string) => `[data-draw-pathopts-field="${name}"]`;
const select = (name: string) => `[data-draw-pathopts-select="${name}"]`;
const toggle = (name: string) => `[data-draw-pathopts-toggle="${name}"]`;
const header = (section: string) => `[data-draw-pathopts-header="${section}"]`;
const apply = (section: string) => `[data-draw-pathopts-apply="${section}"]`;

const valueOf = (panel: MountedPanel, name: string): string =>
  panel.get<HTMLInputElement>(field(name)).value;

/** Check a checkbox (Testing Library's `change` sets `value`; a checkbox
 *  changes through a click). */
async function check(panel: MountedPanel, name: string): Promise<void> {
  await panel.click(toggle(name));
}

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Every mutation the engine is SENT while `fn` runs, verbatim — the
 *  `document.mutate` door held open the way the harness holds `tree`
 *  open (`selectDuringWalk`). The door is put back whatever happens. */
async function sentTo(
  h: HeadlessHost,
  fn: () => Promise<unknown>,
): Promise<unknown[]> {
  const document = h.host.document as {
    mutate: HeadlessHost["host"]["document"]["mutate"];
  };
  const mutate = document.mutate;
  const sent: unknown[] = [];
  document.mutate = function recorded(this: unknown, mutation) {
    sent.push(mutation);
    return mutate.call(this, mutation);
  };
  try {
    await fn();
  } finally {
    document.mutate = mutate;
  }
  return sent;
}

/** Replace one member of a facade without copying the rest. */
function override<T extends object>(target: T, key: string, value: unknown): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      return prop === key ? value : (Reflect.get(obj, prop, receiver) as unknown);
    },
  });
}

/** A view of `host` that CAN raise a panel — the editor's posture. The
 *  headless harness injects no shell backend, so `shell.openPanel` is
 *  recorded here; everything else (the bindings store included) is the
 *  real host's. */
function raisingHost(host: BundleHost): { host: BundleHost; opened: string[] } {
  const opened: string[] = [];
  const shell = override(host.shell, "openPanel", (id: string) => {
    opened.push(id);
  });
  const supports = (feature: string) =>
    feature === "shell.openPanel@1" ? true : host.supports(feature);
  return {
    host: override(override(host, "shell", shell), "supports", supports),
    opened,
  };
}

describe("Path options panel — rendered against the engine", () => {
  describe("the form", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the CONTRIBUTED component mounts: seven sections, Offset open, every field at its command's default", async () => {
      const panel = await mountContributed(h, PATH_OPTIONS_PANEL_ID);
      expect(
        panel
          .all("[data-draw-pathopts-section]")
          .map((el) => el.getAttribute("data-draw-pathopts-section")),
      ).toEqual([...PATH_OPTION_SECTIONS]);
      for (const section of PATH_OPTION_SECTIONS) {
        expect(panel.get(header(section)).textContent).toContain(
          PATH_OPTION_SECTION_TITLES[section],
        );
      }
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("offset");
      expect(valueOf(panel, "offset.delta")).toBe("6");
      expect(panel.get<HTMLSelectElement>(select("offset.join")).value).toBe("miter");
      expect(valueOf(panel, "offset.miterLimit")).toBe("4");
      // Nothing selected: an operation on the selection has no target.
      expect(panel.disabled(apply("offset"))).toBe(true);
      expect(panel.count("[data-draw-pathopts-needs-selection]")).toBe(1);
      expect(panel.get("[data-draw-pathopts-note]").textContent).toBe(
        PATH_OPTIONS_PANEL_NOTE,
      );
    });

    it("one section is open at a time, and a closed one keeps what was typed", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      panel.change(field("offset.delta"), "17");
      await panel.click(header("simplify"));
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("simplify");
      expect(panel.count(field("offset.delta"))).toBe(0);
      expect(valueOf(panel, "simplify.tolerance")).toBe("1");
      await panel.click(header("offset"));
      expect(valueOf(panel, "offset.delta")).toBe("17");
    });

    it("an insert needs no selection; its fields are the generator's real parameters", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const fieldsOf = () =>
        panel
          .all("[data-draw-pathopts-field]")
          .map((el) => el.getAttribute("data-draw-pathopts-field"));
      await panel.click(header("arc"));
      expect(fieldsOf()).toEqual([
        "arc.cx",
        "arc.cy",
        "arc.rx",
        "arc.ry",
        "arc.startAngleDeg",
        "arc.sweepDeg",
      ]);
      expect(panel.count(toggle("arc.closed"))).toBe(1);
      expect(panel.disabled(apply("arc"))).toBe(false);
      await panel.click(header("spiral"));
      expect(fieldsOf()).toEqual([
        "spiral.cx",
        "spiral.cy",
        "spiral.r0",
        "spiral.decay",
        "spiral.turns",
        "spiral.segmentsPerTurn",
      ]);
      await panel.click(header("rectGrid"));
      expect(fieldsOf()).toEqual([
        "rectGrid.x",
        "rectGrid.y",
        "rectGrid.width",
        "rectGrid.height",
        "rectGrid.rows",
        "rectGrid.cols",
      ]);
      await panel.click(header("polarGrid"));
      expect(fieldsOf()).toEqual([
        "polarGrid.cx",
        "polarGrid.cy",
        "polarGrid.r",
        "polarGrid.rings",
        "polarGrid.radials",
      ]);
    });
  });

  describe("the typed parameters reach the engine; ONE undo restores", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    const tableOf = async (id: ElementId) =>
      (await h.host.document.pathAnchors(id))!;

    it("OFFSET: the square grows by the DELTA typed, on every side", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await tableOf(SQ);
      expect(boxOf(before)).toEqual([60, 60, 160, 160]);
      await drive(() => h.host.selection.set([SQ]), panel.work);
      expect(panel.attr(PANEL, "data-draw-pathopts-targets")).toBe("1");
      expect(panel.get(apply("offset")).textContent).toBe("Apply to 1 path");

      panel.change(field("offset.delta"), "12");
      panel.reset();
      await panel.click(apply("offset"));

      // THE DOCUMENT: 12 pt out on every side — not the 6 the command
      // ran on before it could be asked.
      const grown = boxOf(await tableOf(SQ));
      expect(grown[0]).toBeCloseTo(48, 3);
      expect(grown[1]).toBeCloseTo(48, 3);
      expect(grown[2]).toBeCloseTo(172, 3);
      expect(grown[3]).toBeCloseTo(172, 3);
      expect(panel.work.mutations).toEqual([{ op: "offsetPath", ops: 1 }]);
      expect(panel.work.count("log.warn")).toBe(0);

      // ONE undo, and the square is the square again.
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(SQ))).toEqual(shapeOf(before));

      // A DIFFERENT number is a different result: negative shrinks.
      panel.change(field("offset.delta"), "-20");
      await panel.click(apply("offset"));
      const shrunk = boxOf(await tableOf(SQ));
      expect(shrunk[0]).toBeCloseTo(80, 3);
      expect(shrunk[2]).toBeCloseTo(140, 3);
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(SQ))).toEqual(shapeOf(before));
    });

    /** Offset `sq` by 12 pt with `join` chosen in the form; answers the
     *  mutation the engine was SENT and the table it made. Undone. */
    const offsetWithJoin = async (panel: MountedPanel, join: string) => {
      await drive(() => h.host.selection.set([SQ]), panel.work);
      panel.change(field("offset.delta"), "12");
      panel.change(select("offset.join"), join);
      panel.change(field("offset.miterLimit"), "7");
      const sent = await sentTo(h, () => panel.click(apply("offset")));
      const table = await tableOf(SQ);
      await drive(() => h.host.document.undo(), panel.work);
      return { sent, table };
    };

    it("OFFSET: the JOIN and MITER LIMIT typed are on the WIRE — and the section says the engine does not read them yet", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await tableOf(SQ);
      const round = await offsetWithJoin(panel, "round");
      expect(round.sent).toEqual([
        {
          op: "offsetPath",
          args: { elementId: SQ, delta: 12, join: "round", miterLimit: 7 },
        },
      ]);
      // The miter limit means nothing to a round join, and the form says so.
      panel.change(select("offset.join"), "round");
      expect(panel.get<HTMLInputElement>(field("offset.miterLimit")).disabled).toBe(
        true,
      );
      expect(panel.get("[data-draw-pathopts-offset-join-note]").textContent).toBe(
        OFFSET_JOIN_NOTE,
      );
      expect(shapeOf(await tableOf(SQ))).toEqual(shapeOf(before));
    });

    // ENGINE DEFECT, pinned the way `test/oracle/offset-path.spec.ts`
    // pins it: core's `offset_closed_path(_join, _miter_limit)` bevels
    // every outward corner whatever join it is sent, so a MITER offset of
    // a square comes back with eight anchors (a chamfer at each corner)
    // instead of four. `it.fails` — it flips RED the day the kernel
    // honours `join`, which is the day `OFFSET_JOIN_NOTE` must go.
    it.fails(
      "OFFSET: a MITER join gives a square its four corners back (engine: bevels regardless)",
      async () => {
        const panel = await mountPanel(h, makePathOptionsPanel);
        const miter = await offsetWithJoin(panel, "miter");
        expect(miter.table.anchors).toHaveLength(4);
      },
    );

    it("OFFSET: …and until then every join is the same bevel, which is what the note says", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const miter = await offsetWithJoin(panel, "miter");
      const round = await offsetWithJoin(panel, "round");
      const bevel = await offsetWithJoin(panel, "bevel");
      expect(miter.table.anchors).toHaveLength(8);
      expect(shapeOf(round.table)).toEqual(shapeOf(miter.table));
      expect(shapeOf(bevel.table)).toEqual(shapeOf(miter.table));
    });

    it("SIMPLIFY: the TOLERANCE typed decides how many anchors survive", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await tableOf(WOB);
      expect(before.anchors).toHaveLength(7);
      await drive(() => h.host.selection.set([WOB]), panel.work);
      await panel.click(header("simplify"));

      // Below the 8 pt wobble nothing may go…
      panel.change(field("simplify.tolerance"), "2");
      panel.reset();
      await panel.click(apply("simplify"));
      expect(panel.work.mutations).toEqual([{ op: "simplifyPath", ops: 1 }]);
      expect((await tableOf(WOB)).anchors).toHaveLength(7);
      await drive(() => h.host.document.undo(), panel.work);

      // …above it the zig-zag is a line.
      panel.change(field("simplify.tolerance"), "20");
      await panel.click(apply("simplify"));
      expect((await tableOf(WOB)).anchors).toHaveLength(2);
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(WOB))).toEqual(shapeOf(before));
    });

    it("OUTLINE STROKE: untouched it outlines the element's OWN stroke; an override width replaces it", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await tableOf(LN);
      // Give the line a real stroke, so "its own" is not the 1 pt default.
      await drive(async () => {
        const out = await h.host.document.mutate({
          op: "setElementProperty",
          args: {
            elementId: LN,
            path: "frameStrokeWeight",
            value: { type: "length", value: 4 },
          },
        });
        if (!out.applied) throw new Error("stroke weight refused");
        await h.host.selection.set([LN]);
      }, panel.work);
      await panel.click(header("outlineStroke"));
      // The section says what "from the element" will mean for THIS path.
      expect(panel.get("[data-draw-pathopts-own]").textContent).toBe(
        `The element's own stroke: ${ownStrokeLabel({
          width: 4,
          cap: "butt",
          join: "miter",
          miterLimit: 4,
        })}.`,
      );
      expect(panel.get<HTMLInputElement>(field("outlineStroke.width")).disabled).toBe(
        true,
      );

      await panel.click(apply("outlineStroke"));
      const own = boxOf(await tableOf(LN));
      expect(own[3] - own[1]).toBeCloseTo(4, 3);
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(LN))).toEqual(shapeOf(before));

      await check(panel, "outlineStroke.overrideWidth");
      panel.change(field("outlineStroke.width"), "10");
      panel.change(select("outlineStroke.cap"), "square");
      panel.reset();
      await panel.click(apply("outlineStroke"));
      expect(panel.work.mutations).toEqual([{ op: "outlineStroke", ops: 1 }]);
      const wide = boxOf(await tableOf(LN));
      // 10 pt tall, and the SQUARE cap projects half of that past each end.
      expect(wide[3] - wide[1]).toBeCloseTo(10, 3);
      expect(wide[0]).toBeCloseTo(245, 3);
      expect(wide[2]).toBeCloseTo(455, 3);
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(LN))).toEqual(shapeOf(before));
    });

    it("INSERT ARC: the radii, angles and the closed flag typed are the arc inserted", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await leafIds(h);
      expect(before).toHaveLength(PRISTINE);
      await panel.click(header("arc"));
      panel.change(field("arc.cx"), "300");
      panel.change(field("arc.cy"), "350");
      panel.change(field("arc.rx"), "60");
      panel.change(field("arc.ry"), "30");
      panel.change(field("arc.startAngleDeg"), "90");
      panel.change(field("arc.sweepDeg"), "180");
      await check(panel, "arc.closed");
      expect(panel.get(apply("arc")).textContent).toBe("Insert");
      panel.reset();
      await panel.click(apply("arc"));

      const after = await leafIds(h);
      expect(after).toHaveLength(PRISTINE + 1);
      const created = after.find((id) => !before.some((b) => b.id === id.id))!;
      const table = await tableOf(created);
      const typed = arcTablesFor({
        cx: 300,
        cy: 350,
        rx: 60,
        ry: 30,
        startAngleDeg: 90,
        sweepDeg: 180,
        closed: true,
      })[0];
      expect(table.anchors).toHaveLength(typed.anchors.length);
      table.anchors.forEach((a, i) => {
        expect(a.anchor[0]).toBeCloseTo(typed.anchors[i].anchor[0], 6);
        expect(a.anchor[1]).toBeCloseTo(typed.anchors[i].anchor[1], 6);
      });
      expect(table.subpathOpen?.[0]).toBe(false);
      // A half ellipse from the bottom (90°) round to the top: it lies
      // left of the centre.
      const box = boxOf(table);
      expect(box[0]).toBeCloseTo(240, 3);
      expect(box[2]).toBeCloseTo(300, 3);
      expect(box[1]).toBeCloseTo(320, 3);
      expect(box[3]).toBeCloseTo(380, 3);
      expect(panel.work.mutations).toEqual([{ op: "batch", ops: 1 }]);

      await drive(() => h.host.document.undo(), panel.work);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
    });

    it("INSERT RECTANGULAR GRID: rows × columns typed = rows + 1 and columns + 1 lines, and ONE undo removes all of them", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      await panel.click(header("rectGrid"));
      panel.change(field("rectGrid.x"), "300");
      panel.change(field("rectGrid.y"), "330");
      panel.change(field("rectGrid.width"), "90");
      panel.change(field("rectGrid.height"), "60");
      panel.change(field("rectGrid.rows"), "2");
      panel.change(field("rectGrid.cols"), "3");
      const before = await leafIds(h);
      panel.reset();
      await panel.click(apply("rectGrid"));

      const after = await leafIds(h);
      const created = after.filter((id) => !before.some((b) => b.id === id.id));
      expect(created).toHaveLength(3 + 4);
      expect(panel.work.mutations).toEqual([{ op: "batch", ops: 7 }]);
      // Every line lies inside the box typed.
      let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const id of created) {
        const b = boxOf(await tableOf(id));
        box = [
          Math.min(box[0], b[0]),
          Math.min(box[1], b[1]),
          Math.max(box[2], b[2]),
          Math.max(box[3], b[3]),
        ];
      }
      expect(box).toEqual([300, 330, 390, 390]);

      await drive(() => h.host.document.undo(), panel.work);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
    });

    it("INSERT SPIRAL and POLAR GRID: the counts typed are the anchors and paths inserted", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await leafIds(h);

      await panel.click(header("spiral"));
      panel.change(field("spiral.cx"), "300");
      panel.change(field("spiral.cy"), "350");
      panel.change(field("spiral.r0"), "40");
      panel.change(field("spiral.turns"), "2");
      panel.change(field("spiral.segmentsPerTurn"), "6");
      await panel.click(apply("spiral"));
      const withSpiral = await leafIds(h);
      const spiral = withSpiral.find((id) => !before.some((b) => b.id === id.id))!;
      // 2 turns × 6 segments = 12 segments = 13 anchors, starting 40 pt
      // right of the centre.
      const table = await tableOf(spiral);
      expect(table.anchors).toHaveLength(13);
      expect(table.anchors[0].anchor[0]).toBeCloseTo(340, 6);
      expect(table.anchors[0].anchor[1]).toBeCloseTo(350, 6);
      await drive(() => h.host.document.undo(), panel.work);
      expect(await leafIds(h)).toHaveLength(PRISTINE);

      await panel.click(header("polarGrid"));
      panel.change(field("polarGrid.cx"), "300");
      panel.change(field("polarGrid.cy"), "350");
      panel.change(field("polarGrid.r"), "50");
      panel.change(field("polarGrid.rings"), "2");
      panel.change(field("polarGrid.radials"), "5");
      panel.reset();
      await panel.click(apply("polarGrid"));
      expect(await leafIds(h)).toHaveLength(PRISTINE + 2 + 5);
      expect(panel.work.mutations).toEqual([{ op: "batch", ops: 7 }]);
      await drive(() => h.host.document.undo(), panel.work);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
    });
  });

  describe("what a draft survives", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("a RELOAD: typed values outlive the selection change an Apply needs", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      panel.change(field("offset.delta"), "25");
      const reloads = await panel.costOf(() => h.host.selection.set([SQ]));
      expect(reloads.reloads).toBe(1);
      expect(valueOf(panel, "offset.delta")).toBe("25");
      await drive(() => h.host.selection.set([WOB]), panel.work);
      expect(valueOf(panel, "offset.delta")).toBe("25");
    });

    it("an APPLY IN ANOTHER SECTION: remembering one section does not reset what is typed, unapplied, in the next", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      panel.change(field("offset.delta"), "33");
      await drive(() => h.host.selection.set([WOB]), panel.work);
      await panel.click(header("simplify"));
      panel.change(field("simplify.tolerance"), "0.5");
      await panel.click(apply("simplify"));
      await drive(() => h.host.document.undo(), panel.work);
      // Simplify is now "last used"; Offset was never applied.
      expect(lastUsedPathOptions(h.host).simplify.tolerance).toBe(0.5);
      expect(lastUsedPathOptions(h.host).offset).toEqual(PATH_OPTIONS_DEFAULTS.offset);
      await panel.click(header("offset"));
      expect(valueOf(panel, "offset.delta")).toBe("33");
    });

    it("an UNMOUNT: the contributed panel, closed and reopened, still holds the draft and the open section", async () => {
      const first = await mountContributed(h, PATH_OPTIONS_PANEL_ID);
      await first.click(header("spiral"));
      first.change(field("spiral.turns"), "7");
      unmountAll();
      const second = await mountContributed(h, PATH_OPTIONS_PANEL_ID);
      expect(second.attr(PANEL, "data-draw-pathopts-panel")).toBe("spiral");
      expect(valueOf(second, "spiral.turns")).toBe("7");
      // …and it was never applied, so it is not "last used".
      expect(lastUsedPathOptions(h.host).spiral.turns).toBe(
        PATH_OPTIONS_DEFAULTS.spiral.turns,
      );
    });
  });

  describe("last used values, and the commands that repeat them", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    const tableOf = async (id: ElementId) =>
      (await h.host.document.pathAnchors(id))!;

    it("before anything is applied a bare command runs its ORIGINAL defaults (no payload at all)", async () => {
      expect(lastUsedPayload(h.host, "offset")).toBeUndefined();
      expect(lastUsedPayload(h.host, "arc")).toBeUndefined();
      await h.host.selection.set([SQ]);
      await commandFor(h, OFFSET_PATH_COMMAND_ID).handler(undefined);
      const grown = boxOf(await tableOf(SQ));
      expect(grown[0]).toBeCloseTo(54, 3); // the 6 pt default
      await h.host.document.undo();
    });

    it("after an Apply the SAME command id, run bare, repeats what was applied", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const before = await tableOf(SQ);
      await drive(() => h.host.selection.set([SQ]), panel.work);
      panel.change(field("offset.delta"), "15");
      panel.change(select("offset.join"), "bevel");
      await panel.click(apply("offset"));
      await drive(() => h.host.document.undo(), panel.work);

      expect(lastUsedPayload(h.host, "offset")).toEqual({
        delta: 15,
        join: "bevel",
        miterLimit: 4,
      });
      await drive(
        () => commandFor(h, OFFSET_PATH_COMMAND_ID).handler(undefined),
        panel.work,
      );
      const again = boxOf(await tableOf(SQ));
      expect(again[0]).toBeCloseTo(45, 3);
      expect(again[2]).toBeCloseTo(175, 3);
      await drive(() => h.host.document.undo(), panel.work);
      expect(shapeOf(await tableOf(SQ))).toEqual(shapeOf(before));

      // A payload still wins over what is remembered.
      await drive(
        () => commandFor(h, OFFSET_PATH_COMMAND_ID).handler(undefined, { delta: 2 }),
        panel.work,
      );
      expect(boxOf(await tableOf(SQ))[0]).toBeCloseTo(58, 3);
      await drive(() => h.host.document.undo(), panel.work);
    });

    it("the same for an insert: Insert arc, run bare, is the arc last inserted from the panel", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      await panel.click(header("arc"));
      panel.change(field("arc.rx"), "20");
      panel.change(field("arc.ry"), "20");
      await panel.click(apply("arc"));
      await drive(() => h.host.document.undo(), panel.work);

      const before = await leafIds(h);
      await drive(
        () => commandFor(h, INSERT_ARC_COMMAND_ID).handler(undefined),
        panel.work,
      );
      const after = await leafIds(h);
      const created = after.find((id) => !before.some((b) => b.id === id.id))!;
      const box = boxOf(await tableOf(created));
      // Radius 20 about (200, 200) — not the 100 the command used to run.
      expect(box[0]).toBeCloseTo(180, 3);
      expect(box[2]).toBeCloseTo(220, 3);
      await drive(() => h.host.document.undo(), panel.work);
    });

    it("a remembered value from another build is sanitised, not trusted", async () => {
      h.host.storage.set("pathOptions.v1", {
        offset: { delta: "wide", join: "mitre", miterLimit: 9 },
        rectGrid: { rows: 100000 },
        simplify: null,
      });
      const all = lastUsedPathOptions(h.host);
      expect(all.offset).toEqual({ delta: 6, join: "miter", miterLimit: 9 });
      expect(all.rectGrid.rows).toBe(200); // the count ceiling
      expect(all.simplify).toEqual(PATH_OPTIONS_DEFAULTS.simplify);
      h.host.storage.delete("pathOptions.v1");
    });
  });

  describe("the “…” commands", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("every “…” row of the menu RAISES a section — Image trace is the one that still does not", () => {
      const raisers = new Set(
        Object.values(PATH_OPTIONS_COMMANDS).map((id) =>
          id.slice(MENU_COMMAND_PREFIX.length + 1),
        ),
      );
      const ellipsis = MENU_ENTRIES.filter(([path]) => path.endsWith("…"));
      expect(ellipsis.map(([path]) => path)).toEqual([
        "Draw/Path/Outline stroke options…",
        "Draw/Path/Offset path…",
        "Draw/Path/Simplify…",
        "Object/Insert arc…",
        "Object/Insert spiral…",
        "Object/Insert rectangular grid…",
        "Object/Insert polar grid…",
        "Draw/Image trace…",
      ]);
      expect(
        ellipsis.filter(([, suffix]) => !raisers.has(suffix)).map(([path]) => path),
      ).toEqual(["Draw/Image trace…"]);
      // And nothing WITHOUT an ellipsis raises a dialog.
      expect(
        MENU_ENTRIES.filter(
          ([path, suffix]) => !path.endsWith("…") && raisers.has(suffix),
        ),
      ).toEqual([]);
    });

    it("on a host that can raise a panel: the panel is opened, the section is named, NOTHING is mutated", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      const raising = raisingHost(h.host);
      await drive(() => h.host.selection.set([SQ]), panel.work);
      const before = shapeOf(await h.host.document.pathAnchors(SQ));
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("offset");

      panel.reset();
      await drive(() => openPathOptions(raising.host, "simplify"), panel.work);
      expect(raising.opened).toEqual([PATH_OPTIONS_PANEL_ID]);
      expect(pathOptionsFocusOf(h.host)?.section).toBe("simplify");
      // The OPEN panel followed the request…
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("simplify");
      // …and the document is untouched: the row asked, it did not act.
      expect(shapeOf(await h.host.document.pathAnchors(SQ))).toEqual(before);

      // Asking for the section the user has since left opens it AGAIN.
      await panel.click(header("arc"));
      await drive(() => showPathOptions(raising.host, "simplify"), panel.work);
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("simplify");
      expect(raising.opened).toHaveLength(2);
    });

    it("a panel that is not open yet opens AT the section the command named", async () => {
      const raising = raisingHost(h.host);
      showPathOptions(raising.host, "polarGrid");
      const panel = await mountContributed(h, PATH_OPTIONS_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-pathopts-panel")).toBe("polarGrid");
    });

    it("on a host with NO panel door the row degrades to applying — with the last used values, and it says so", async () => {
      expect(h.host.supports("shell.openPanel@1")).toBe(false);
      const before = await leafIds(h);
      const infos: string[] = [];
      const log = override(h.host.log, "info", (m: string) => void infos.push(m));
      await openPathOptions(override(h.host, "log", log), "polarGrid");
      // 3 rings + 6 spokes: the command's defaults (never applied here).
      expect(await leafIds(h)).toHaveLength(before.length + 9);
      expect(infos.join("\n")).toContain("cannot raise a panel");
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(before.length);
    });
  });

  // COVERS: `reload()`. This panel keeps no records and walks nothing:
  // a reload reads the first selected path's own stroke, or nothing.
  describe("reload budgets (40 plain leaves + 3 seeds)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(SEEDS));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("THE FLOOR: mounting with nothing selected reads NOTHING", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 0,
        reads: 0,
        partReads: 0,
      });
    });

    it("one selected path = ONE property read (its own stroke)", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      expect(await panel.costOf(() => h.host.selection.set([SQ]))).toEqual({
        events: 1,
        reloads: 1,
        walks: 0,
        reads: 1,
        partReads: 0,
      });
      expect(panel.work.count("document.elementProperties")).toBe(1);
    });

    it("a burst of 20 selection changes = ONE reload = 1 read", async () => {
      const panel = await mountPanel(h, makePathOptionsPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        reloads: 1,
        walks: 0,
        reads: 1,
        partReads: 0,
      });
    });
  });
});
