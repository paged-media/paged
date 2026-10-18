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

// The GESTURE MATRIX, run: every specified cell of the committed table
// (gesture-matrix.json — tool × modifier set × zoom × target type, the
// expected outcome per cell) performed through the gesture DSL in the
// real editor, on the gesture fixture's targets (a frame, a group, a
// rotated frame, a locked frame, a master item, empty page), judged by
// the MODEL (the scene tree, geometry and the dump), and undone.
//
// One test per tool and zoom; its cells run in order on one document,
// each restored to the baseline dump by ONE undo (two would be an INV-1
// break, and is reported). A cell marked `known: <finding>` is expected
// to FAIL today: when it passes, the test fails and asks for the marker
// to be removed — the same contract as an expected-failure test, per
// cell. The registry gate (packages/tools/test/gesture-matrix.test.ts)
// keeps the table in step with the registered tools.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import {
  cellId,
  expandMatrix,
  GESTURE_TARGETS as T,
  matrixModifierKeys,
  validateMatrix,
  MATRIX_ZOOMS,
  type GestureDsl,
  type GestureMatrix,
  type MatrixCell,
  type MatrixTarget,
} from "@paged-media/test-kit";

import {
  boxOf,
  browserModel,
  browserSend,
  cornersOf,
  gestureEditor,
  loadGestureFixture,
  selectElements,
} from "./harness/gesture-kit";

/** `PAGED_GESTURE_MATRIX_ZOOMS=1,4` runs those zooms only (a quick local
 *  loop); the default is every zoom the table has. */
const ZOOMS = process.env.PAGED_GESTURE_MATRIX_ZOOMS
  ? MATRIX_ZOOMS.filter((z) =>
      process.env
        .PAGED_GESTURE_MATRIX_ZOOMS!.split(",")
        .map(Number)
        .includes(z),
    )
  : MATRIX_ZOOMS;

const MATRIX = validateMatrix(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./gesture-matrix.json", import.meta.url)),
      "utf8",
    ),
  ) as GestureMatrix,
);

type Id = { kind: string; id: string };
type Pt = [number, number];

/** Where each target type is on page 1, and what a gesture there acts on. */
const TARGETS: Record<
  MatrixTarget,
  { at: Pt; id: Id | null; selectable: boolean }
> = {
  empty: { at: [T.empty.at[0], T.empty.at[1]], id: null, selectable: false },
  frame: {
    at: [T.frame.at[0], T.frame.at[1]],
    id: T.frame.id,
    selectable: true,
  },
  group: {
    at: [T.group.at[0], T.group.at[1]],
    id: T.group.id,
    selectable: true,
  },
  rotated: {
    at: [T.rotated.at[0], T.rotated.at[1]],
    id: T.rotated.id,
    selectable: true,
  },
  locked: {
    at: [T.locked.at[0], T.locked.at[1]],
    id: T.locked.id,
    selectable: true,
  },
  master: { at: [T.master.at[0], T.master.at[1]], id: null, selectable: false },
};

const KINDS = [
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "textFrame",
  "group",
];

/** Element ids by kind, from ONE scene-tree read. */
async function census(page: Page): Promise<Record<string, string[]>> {
  const reply = (await browserSend(page)({
    kind: "requestSceneTree",
  })) as unknown as {
    payload: { roots: Array<{ id?: Id | null; children?: unknown[] }> };
  };
  const out: Record<string, string[]> = Object.fromEntries(
    KINDS.map((k) => [k, [] as string[]]),
  );
  const walk = (n: { id?: Id | null; children?: unknown[] }) => {
    if (n.id && out[n.id.kind]) out[n.id.kind].push(n.id.id);
    for (const c of (n.children ?? []) as typeof reply.payload.roots) walk(c);
  };
  reply.payload.roots.forEach(walk);
  return out;
}

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const angleOf = (cs: Pt[]) =>
  (Math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180) / Math.PI;
const sideRatio = (cs: Pt[]) =>
  Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]) /
  Math.hypot(cs[2][0] - cs[1][0], cs[2][1] - cs[1][1]);
const sides = (cs: Pt[]) => [
  Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]),
  Math.hypot(cs[2][0] - cs[1][0], cs[2][1] - cs[1][1]),
];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** The page box a drag from `a` to `b` should make, by shape. */
function expectedBox(shape: string, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  if (shape === "square")
    return {
      left: a[0],
      top: a[1],
      right: a[0] + Math.sign(dx) * m,
      bottom: a[1] + Math.sign(dy) * m,
    };
  if (shape === "from-centre")
    return {
      left: a[0] - Math.abs(dx),
      top: a[1] - Math.abs(dy),
      right: a[0] + Math.abs(dx),
      bottom: a[1] + Math.abs(dy),
    };
  if (shape === "square-from-centre")
    return { left: a[0] - m, top: a[1] - m, right: a[0] + m, bottom: a[1] + m };
  if (shape === "45deg") {
    const len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const e: Pt = [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
    return {
      left: Math.min(a[0], e[0]),
      top: Math.min(a[1], e[1]),
      right: Math.max(a[0], e[0]),
      bottom: Math.max(a[1], e[1]),
    };
  }
  return {
    left: Math.min(a[0], b[0]),
    top: Math.min(a[1], b[1]),
    right: Math.max(a[0], b[0]),
    bottom: Math.max(a[1], b[1]),
  };
}

interface CellRun {
  ok: boolean;
  detail: string;
}

/** Perform one cell and judge it by the model. */
async function runCell(
  page: Page,
  g: GestureDsl,
  cell: MatrixCell,
): Promise<CellRun> {
  const target = TARGETS[cell.target];
  const mods = matrixModifierKeys(cell.mods);
  const z = cell.zoom;
  const vec: Pt = [MATRIX.dragPx[0] / z, MATRIX.dragPx[1] / z];
  const subject = cell.target === "group" ? (T.group.childA as Id) : target.id;
  const before = await census(page);
  const subjectBefore = subject ? await cornersOf(page, subject) : null;
  const otherChildBefore = await cornersOf(page, T.group.childB);
  const groupBefore = await cornersOf(page, T.group.id);
  const dumpBefore = await browserModel(page).dump();

  // As a user does it: with the Selection tool, select (or deselect),
  // THEN pick the tool. (A transform tool reads the selection it was
  // picked with — see the GM-1 regression in ux-audit-gestures.spec.ts.)
  await g.tool("paged.tool.select").settle();
  await selectElements(
    page,
    cell.gesture === "select-then-drag" && target.selectable && target.id
      ? [target.id]
      : [],
  );
  await g.tool(cell.tool).settle();
  let from = target.at;
  let to = add(from, vec);
  if (cell.gesture === "drag") {
    await g.drag({ from, to, mods, steps: 8 }).settle();
  } else if (cell.gesture === "select-then-drag") {
    // Beside the target and across the drag, so the drag turns about the
    // selection's centre by ~60° (a rotate) and changes its extent (a scale).
    from = add(target.at, [-43 / z, 65 / z]);
    to = add(from, vec);
    await g.drag({ from, to, mods, steps: 8 }).settle();
  } else {
    const p1 = add(from, [80 / z, 12 / z]);
    const p2 = add(from, [30 / z, 70 / z]);
    await g
      .click(from)
      .settle()
      .click(p1, { mods })
      .settle()
      .click(p2, { mods })
      .settle()
      .key("Enter")
      .settle();
  }
  await g.key("Escape").settle();

  const after = await census(page);
  const e = cell.expect!;
  const tol = 1.5 / z + 0.5;
  const snapTol = 8 / z + 1;
  if ("unchanged" in e) {
    const same = (await browserModel(page).dump()) === dumpBefore;
    return { ok: same, detail: same ? "unchanged" : "the document changed" };
  }
  if ("creates" in e) {
    const fresh = after[e.creates].filter(
      (id) => !before[e.creates].includes(id),
    );
    if (fresh.length !== 1)
      return { ok: false, detail: `${fresh.length} new ${e.creates}(s)` };
    const box = boxOf(
      (await cornersOf(page, { kind: e.creates, id: fresh[0] }))!,
    );
    if (e.shape === "path") return { ok: true, detail: "one new path" };
    if (cell.gesture === "pen-path") {
      const reply = (await browserSend(page)({
        kind: "requestPathAnchors",
        payload: { id: { kind: e.creates, id: fresh[0] } as never },
      })) as unknown as {
        payload: { result: { anchors: Array<{ anchor: Pt }> } | null };
      };
      const an = (reply.payload.result?.anchors ?? []).map((a) => a.anchor);
      if (an.length < 2) return { ok: false, detail: `${an.length} anchors` };
      const ang =
        (Math.atan2(an[1][1] - an[0][1], an[1][0] - an[0][0]) * 180) / Math.PI;
      const ok = an.length === 3 && near(((ang % 45) + 45) % 45, 0, 0.5);
      return {
        ok,
        detail: `segment at ${ang.toFixed(2)}°, ${an.length} anchors`,
      };
    }
    const want = expectedBox(e.shape, from, to);
    const ok =
      near(box.left, want.left, tol) &&
      near(box.top, want.top, tol) &&
      near(box.right, want.right, tol) &&
      near(box.bottom, want.bottom, tol);
    return {
      ok,
      detail: `box ${JSON.stringify(box)} want ${JSON.stringify(want)}`,
    };
  }
  if ("moves" in e || "duplicates" in e) {
    const constraint = "moves" in e ? e.constraint : e.constraint;
    const want: Pt = constraint === "axis" ? [vec[0], 0] : vec;
    if ("duplicates" in e) {
      const kind = cell.target === "group" ? "group" : subject!.kind;
      const fresh = after[kind].filter((id) => !before[kind].includes(id));
      const stayed =
        subjectBefore &&
        JSON.stringify(await cornersOf(page, subject!)) ===
          JSON.stringify(subjectBefore);
      return {
        ok: fresh.length === 1 && Boolean(stayed),
        detail: `${fresh.length} copy(ies); original ${stayed ? "stayed" : "moved"}`,
      };
    }
    const now = await cornersOf(page, subject!);
    const moved: Pt = [
      now![0][0] - subjectBefore![0][0],
      now![0][1] - subjectBefore![0][1],
    ];
    let ok =
      near(moved[0], want[0], snapTol) && near(moved[1], want[1], snapTol);
    if (e.moves === "child") {
      const other = await cornersOf(page, T.group.childB);
      ok = ok && JSON.stringify(other) === JSON.stringify(otherChildBefore);
    }
    return {
      ok,
      detail: `moved ${moved.map((n) => n.toFixed(1)).join(",")} want ${want.map((n) => n.toFixed(1)).join(",")}`,
    };
  }
  const id = target.id!;
  const c0 = id.kind === "group" ? groupBefore! : subjectBefore!;
  const c1 = (await cornersOf(page, id))!;
  // A rotate or scale turns about the selection's centre (no pivot was
  // clicked): the centre of the target's box stays where it was.
  const centre = (cs: Pt[]): Pt => [
    (cs[0][0] + cs[2][0]) / 2,
    (cs[0][1] + cs[2][1]) / 2,
  ];
  const kept =
    near(centre(c1)[0], centre(c0)[0], snapTol) &&
    near(centre(c1)[1], centre(c0)[1], snapTol);
  const centreDetail = `centre ${centre(c0).map((n) => n.toFixed(1))} → ${centre(c1).map((n) => n.toFixed(1))}`;
  if ("rotates" in e) {
    const d = angleOf(c1) - angleOf(c0);
    const turned = Math.abs(d) > 0.5 && near(sides(c1)[0], sides(c0)[0], 0.5);
    const snapped = e.snap
      ? near(((d % e.snap) + e.snap) % e.snap, 0, 0.5) ||
        near(((d % e.snap) + e.snap) % e.snap, e.snap, 0.5)
      : true;
    return {
      ok: turned && snapped && kept,
      detail: `turned ${d.toFixed(2)}°, ${centreDetail}`,
    };
  }
  const grew =
    !near(sides(c1)[0], sides(c0)[0], 0.5) ||
    !near(sides(c1)[1], sides(c0)[1], 0.5);
  const uniform = e.uniform ? near(sideRatio(c1), sideRatio(c0), 0.01) : true;
  return {
    ok: grew && uniform && kept,
    detail: `sides ${sides(c0).map((n) => n.toFixed(1))} → ${sides(c1).map((n) => n.toFixed(1))}, ${centreDetail}`,
  };
}

const cells = expandMatrix(MATRIX).filter((c) => c.expect);
const tools = [...new Set(cells.map((c) => c.tool))];

for (const tool of tools) {
  for (const zoom of ZOOMS) {
    const mine = cells.filter((c) => c.tool === tool && c.zoom === zoom);
    test(`gesture matrix: ${tool} @${zoom * 100}% (${mine.length} cells) @level:gesture`, async ({
      page,
    }) => {
      test.setTimeout(6 * 60_000);
      const { g } = await gestureEditor(page);
      await g.zoom(zoom).settle();
      const model = browserModel(page);
      const baseline = await model.dump();
      const problems: string[] = [];
      for (const cell of mine) {
        let run: CellRun;
        try {
          run = await runCell(page, g, cell);
        } catch (err) {
          run = { ok: false, detail: `threw: ${String(err).slice(0, 200)}` };
        }
        if (process.env.PAGED_GESTURE_MATRIX_VERBOSE) {
          console.info(
            `${run.ok ? "ok  " : "FAIL"} ${cell.known ? `[${cell.known}] ` : ""}${cellId(cell)}: ${run.detail}`,
          );
        }
        if (cell.known && run.ok)
          problems.push(
            `${cellId(cell)}: UNEXPECTEDLY PASSED — the fix for ${cell.known} landed; remove its "known" from gesture-matrix.json`,
          );
        if (!cell.known && !run.ok)
          problems.push(
            `${cellId(cell)}: expected ${JSON.stringify(cell.expect)} — ${run.detail}`,
          );
        // Back to the baseline by ONE undo (INV-1).
        let undos = 0;
        while ((await model.dump()) !== baseline && undos < 3) {
          await model.undo().catch(() => undefined);
          undos++;
        }
        if (undos > 1)
          problems.push(
            `${cellId(cell)}: needed ${undos} undos to restore (INV-1)`,
          );
        if ((await model.dump()) !== baseline) {
          problems.push(
            `${cellId(cell)}: undo did not restore the document; reloaded`,
          );
          await loadGestureFixture(page);
          await g.zoom(zoom).settle();
        }
      }
      expect(problems).toEqual([]);
    });
  }
}
