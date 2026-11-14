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

// `paged.insert.barcode` — Insert barcode…: a data string in EAN-13, UPC-A,
// Code-128 or QR, drawn as vector modules on the current page.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A MODULE. The encoder
// (`paged-data-barcode`) is a dependency-free leaf of the engine, and
// `paged.barcode(symbology, data)` (a host function of the engine's script
// surface) answers its unit-box geometry without a binding, a data table or
// the data module. So doc and slide, which have no data wasm of their own,
// get the same insert as every other document (PM-0017: built-ins always
// present; one implementation). paged.data's bound barcode keeps its own
// lowering (`lower_barcode`): it draws a symbol from a record, this one from
// a typed string.
//
//  1. RUN BARE (the menu row, the palette) the command opens the Barcode
//     dialog; run with a payload (`symbology`, `data`, optionally `width`,
//     `height`, `quietZone`, `cx`, `cy` page-local pt and a `page` id) it
//     inserts. The dialog's OK runs the same command.
//  2. THE WRITE is ONE batch (one undo step): one filled rectangle per run of
//     adjacent dark modules, black on no stroke (a default 1 pt stroke would
//     widen every bar and break the bar/space ratios a scanner reads), then a
//     group of them, which is selected. The human-readable line a 1D symbol
//     carries under its bars is not drawn.

import {
  commandNeeds,
  scopeOf,
  type CommandContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import type { Mutation } from "@paged-media/client";
import { mutateAndSelect } from "@paged-media/tools";
import { defineMessages, t } from "@paged-media/strings";

import {
  blockedFor,
  currentPageTarget,
  insertApplies,
  outcomeOf,
  refused,
  refusedTap,
  REFUSED,
  type InsertOutcome,
  type InsertReport,
} from "./insert-commands";
import { layoutPages } from "./ui/layout";
import { openBarcodeDialog } from "./panels/barcode-dialog";

const M = defineMessages("app.barcodeCommands", {
  title: "Insert: Barcode…",
  noData: "a barcode needs data to encode.",
  noEngine: "the engine does not answer a barcode here.",
  noModules: "the symbol has no dark modules.",
});

export const PAGED_INSERT_BARCODE = "paged.insert.barcode";

const VERB = "Insert barcode";

/** The symbologies the engine encodes, in the dialog's order. */
export const BARCODE_SYMBOLOGIES = ["ean13", "upca", "code128", "qr"] as const;
export type BarcodeSymbology = (typeof BARCODE_SYMBOLOGIES)[number];

/** The size a symbol is drawn at unless the payload names one (pt): bars
 *  wider than tall, a matrix square. */
export const BARCODE_DEFAULT_SIZE_PT: Readonly<
  Record<BarcodeSymbology, readonly [number, number]>
> = {
  ean13: [150, 72],
  upca: [150, 72],
  code128: [180, 72],
  qr: [108, 108],
};

/** The swatches a module is painted with (as paged.data's barcode does):
 *  `Color/Black` is in every document, never the registration colour. */
const FILL = "Color/Black";
const STROKE = "Swatch/None";

interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What `paged.barcode` answers. */
export interface BarcodeAnswer {
  geometry?: { symbology: string; rects: UnitRect[]; text: string };
  error?: string;
}

/** Whether a payload carries any barcode parameter (so the command inserts
 *  rather than opening the dialog). */
export function hasBarcodeParams(payload: unknown): boolean {
  const p = (payload ?? {}) as Record<string, unknown>;
  return ["symbology", "data", "width", "height", "quietZone", "cx", "cy"].some(
    (k) => k in p,
  );
}

/** Ask the engine to encode (`paged.barcode`, a pure read). */
export async function encodeBarcode(
  paged: PagedEditor,
  symbology: string,
  data: string,
  quietZone = 0,
): Promise<BarcodeAnswer | null> {
  const source = `paged.barcode(${JSON.stringify(symbology)}, ${JSON.stringify(
    data,
  )}, ${Math.max(0, Math.round(quietZone))})`;
  const reply = await paged.client.executeScript(source);
  const raw = reply.output[0];
  if (reply.error || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as BarcodeAnswer;
  } catch {
    return null;
  }
}

/** Merge dark modules that touch on one row into a single rectangle (a QR
 *  module row of eight is one op, not eight). Rects of one row share `y`
 *  and `h`; two touch when the first ends where the next begins. */
export function mergeRuns(rects: readonly UnitRect[]): UnitRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: UnitRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.y - r.y) < 1e-9 &&
      Math.abs(last.h - r.h) < 1e-9 &&
      Math.abs(last.x + last.w - r.x) < 1e-9
    ) {
      last.w = r.x + r.w - last.x;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

const HANDLE = "bc";

/** The batch that draws `rects` (unit box) at page-local `[left, top]` scaled
 *  to `width` x `height`: insert, bind, paint per rectangle, then one group of
 *  them. A single rectangle is not grouped (a group needs two members). */
export function barcodeBatch(
  pageId: string,
  rects: readonly UnitRect[],
  left: number,
  top: number,
  width: number,
  height: number,
): Mutation {
  const ops: unknown[] = [];
  const members: unknown[] = [];
  rects.forEach((r, i) => {
    const x = left + r.x * width;
    const y = top + r.y * height;
    const w = r.w * width;
    const h = r.h * height;
    const corners: [number, number][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const handle = `${HANDLE}${i}`;
    const id = { kind: "polygon", id: `$h:${handle}` };
    ops.push(
      {
        op: "insertPath",
        args: {
          pageId,
          anchors: corners.map((p) => ({ anchor: p, left: p, right: p })),
          open: false,
        },
      },
      { op: "bindCreated", args: { handle } },
      {
        op: "setElementProperty",
        args: {
          elementId: id,
          path: "frameFillColor",
          value: { type: "colorRef", value: FILL },
        },
      },
      {
        op: "setElementProperty",
        args: {
          elementId: id,
          path: "frameStrokeColor",
          value: { type: "colorRef", value: STROKE },
        },
      },
    );
    members.push(id);
  });
  if (members.length > 1) {
    ops.push({ op: "createGroup", args: { memberIds: members } });
  }
  return { op: "batch", args: { ops } } as unknown as Mutation;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Insert a barcode: centred on the current page unless the payload names a
 *  page and a centre. */
export async function insertBarcode(
  paged: PagedEditor,
  report: InsertReport,
  payload?: Record<string, unknown>,
): Promise<InsertOutcome> {
  if (blockedFor(paged, report, VERB)) return REFUSED;
  const target = currentPageTarget(paged);
  if (!target) return REFUSED;
  const symbology = String(payload?.symbology ?? "qr");
  const data = String(payload?.data ?? "");
  if (data.length === 0) {
    report("error", refused(VERB, t(M.noData)));
    return REFUSED;
  }
  const answer = await encodeBarcode(
    paged,
    symbology,
    data,
    num(payload?.quietZone) ?? 0,
  );
  if (!answer) {
    report("error", refused(VERB, t(M.noEngine)));
    return REFUSED;
  }
  if (answer.error || !answer.geometry) {
    report("error", refused(VERB, answer.error ?? t(M.noEngine)));
    return REFUSED;
  }
  const rects = mergeRuns(answer.geometry.rects);
  if (rects.length === 0) {
    report("error", refused(VERB, t(M.noModules)));
    return REFUSED;
  }
  let pageId = target.pageId;
  let rect = target.rect;
  const named = typeof payload?.page === "string" ? payload.page : null;
  const handle = paged.document.handle;
  if (named && handle) {
    const i = handle.pageIds.indexOf(named as never);
    const rects2 = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
    if (i >= 0 && rects2[i]) {
      pageId = handle.pageIds[i]!;
      rect = rects2[i]!;
    }
  }
  const known = answer.geometry.symbology as BarcodeSymbology;
  const fallback = BARCODE_DEFAULT_SIZE_PT[known] ?? BARCODE_DEFAULT_SIZE_PT.qr;
  const width = Math.max(1, num(payload?.width) ?? fallback[0]);
  const height = Math.max(1, num(payload?.height) ?? fallback[1]);
  const cx = num(payload?.cx) ?? rect.w / 2;
  const cy = num(payload?.cy) ?? rect.h / 2;
  const mutation = barcodeBatch(
    pageId as string,
    rects,
    cx - width / 2,
    cy - height / 2,
    width,
    height,
  );
  const reply = await mutateAndSelect(
    paged,
    mutation,
    "insertBarcode",
    refusedTap(report, VERB),
  );
  return outcomeOf(reply);
}

/** Gated like every insert: a document, at its root. */
export function buildBarcodeCommands(
  report: InsertReport,
  clear: () => void,
): CommandContribution[] {
  return [
    {
      id: PAGED_INSERT_BARCODE,
      get title() {
        return t(M.title);
      },
      category: "Insert",
      when: insertApplies,
      applicability: commandNeeds("document", "outsideContext"),
      handler: (paged, payload) => {
        if (!hasBarcodeParams(payload)) {
          openBarcodeDialog(scopeOf(paged));
          return undefined;
        }
        clear();
        return insertBarcode(
          paged as PagedEditor,
          report,
          payload as Record<string, unknown>,
        );
      },
    },
  ];
}

/** Object > Insert barcode…, beside the other inserts. The gate is the
 *  inserts' own (a document at its root), so the row is there in every
 *  kind of document: doc and slide included. */
export const BARCODE_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Object/Insert barcode…",
    command: PAGED_INSERT_BARCODE,
    order: 5.6,
    group: "insert",
    when: insertApplies,
  },
];
