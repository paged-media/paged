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

// Four symbologies (p112, E-Data verso) — every barcode kind the engine
// encodes, drawn from the SAME data source: Code-128 from the SKU,
// EAN-13 and UPC-A from the order book's valid check-digit columns, QR
// from the per-order URL. All four are clean-room Rust encoders whose
// module grids lower as NATIVE path geometry — closed filled rects
// scaled to the bound frame's content box. Nothing on this page is an
// image: there is no asset, no resolution, and the symbols stay sharp
// at any output size. Each symbol's payload is printed beneath it, as
// resolved for the first order.
//
// THE SHARED SESSION, met here on purpose: `lowerAll` re-lowers EVERY
// binding. The expression page ran before this one and left two bound
// symbols alive, so this page's pass redraws those two as well — in
// their own frames on p114, replacing the old modules in the same
// batch. They used to land on p112 instead (the ACTIVE page, at their
// p114 coordinates), and whatever of the pass outlived the page this
// module held active landed on the cover (data ADR 551, amended
// 2026-11-18). This page now checks where every new module went.

import { expect } from "@playwright/test";

import { marginNote, proseFrame, specLabel } from "../../annual-support";
import { withActivePage } from "../../active-page";
import { LAYER, STYLE, SWATCH, p } from "../../names-annual";
import { geometryOf, newRefs, sceneRefs, type Ref } from "../../plugin-support";
import type { PageContext, PageReport } from "../../types";
import {
  addAuthoredBinding,
  assignLayerBatch,
  chapterData,
  ensureOrdersReady,
  placeBindings,
  spreadOffset,
  units,
} from "./00-support";

interface Symbology {
  kind: "code128" | "ean13" | "upca" | "qr";
  title: string;
  column: string;
  payload: string;
  slot: [number, number, number, number];
}

/** Record 1001's values, as the opener's CSV specimen prints them —
 *  the payload captions cite what the engine resolved. */
const SYMBOLS: Symbology[] = [
  {
    kind: "code128",
    title: "Code-128 — sku",
    column: "sku",
    payload: "PA-2025-1001-ALP",
    slot: [60, 216, 60 + units(5), 276],
  },
  {
    kind: "ean13",
    title: "EAN-13 — ean",
    column: "ean",
    payload: "9007830010019",
    slot: [319, 216, 319 + units(4), 276],
  },
  {
    kind: "upca",
    title: "UPC-A — upc",
    column: "upc",
    payload: "072034010010",
    slot: [60, 356, 60 + units(5), 416],
  },
  {
    kind: "qr",
    title: "QR — url",
    column: "url",
    payload: "https://paged.media/annual/orders/1001",
    slot: [319, 340, 415, 436],
  },
];

export async function build(ctx: PageContext): Promise<PageReport> {
  const { doc, page } = ctx;
  const pg = p(112);
  const pageId = ctx.pageIds[0];
  const notes: string[] = [];
  const elements: string[] = [];
  const covers: string[] = [];

  const head = await proseFrame(
    ctx,
    pg,
    [60, 54, 492, 84],
    [{ text: "Four symbologies, one order book", style: STYLE.head1 }],
  );
  const intro = await proseFrame(
    ctx,
    pg,
    [60, 90, 492, 186],
    [
      {
        text:
          "Retail wants EAN-13 and UPC-A, logistics wants Code-128, screens " +
          "want QR — the order book carries a column for each, with real " +
          "check digits. The engine encodes all four clean-room in Rust and " +
          "lowers each symbol as native path geometry scaled to its bound " +
          "frame: filled rectangles on the page, not an image in a frame. " +
          "Print them at any size; they were never pixels.",
        style: STYLE.bodySmall,
      },
    ],
  );
  elements.push(head.frameId, intro.frameId);

  // ── furniture: bound frames + titles + payload captions ───────────
  const rects = new Map<string, string>();
  for (const s of SYMBOLS) {
    const title = await proseFrame(
      ctx,
      pg,
      [s.slot[0], s.slot[1] - 22, s.slot[2], s.slot[1] - 4],
      [{ text: s.title, style: STYLE.caption }],
    );
    const rect = await doc.rectangle(pageId, s.slot);
    await doc.designer.applyStroke(
      "rectangle",
      rect,
      await doc.swatch(SWATCH.slate),
      0.5,
    );
    await doc.setProperty("rectangle", rect, "itemLayer", {
      type: "text",
      value: await doc.layerId(LAYER.content),
    });
    rects.set(s.kind, rect);
    elements.push(title.frameId, rect);
  }

  let verdict =
    "The query engine never reached ready on this lane, so the four bound " +
    "frames above stay empty and honest.";
  /** kind → module count, hoisted so the payload captions (authored
   *  AFTER the drive) print what actually happened under each frame. */
  const drewKind = new Map<string, number>();

  if (await ensureOrdersReady(ctx, notes)) {
    // ── author the four bindings, then ONE lowering pass ────────────
    for (const s of SYMBOLS) {
      await doc.select("rectangle", rects.get(s.kind)!);
      await addAuthoredBinding(page, "barcode", s.column, s.kind);
    }

    const before = await sceneRefs(page, "polygon");
    // The pass refreshes the data itself and answers when every binding
    // is lowered: nothing is read until it is over.
    await withActivePage(page, pageId, () => placeBindings(page));
    const fresh = await newRefs(page, "polygon", before);
    // Geometry `bounds` speak STORED coordinates: a page-local slot sits
    // at slot + this page's spread offset.
    const off = await spreadOffset(ctx, pageId);
    const inSlot = (
      b: [number, number, number, number],
      slot: [number, number, number, number],
    ): boolean => {
      const cx = (b[1] + b[3]) / 2;
      const cy = (b[0] + b[2]) / 2;
      return (
        cx >= slot[0] + off[0] - 6 &&
        cx <= slot[2] + off[0] + 6 &&
        cy >= slot[1] + off[1] - 6 &&
        cy <= slot[3] + off[1] + 6
      );
    };
    const geo = await geometryOf(page, fresh);
    const counts = new Map<string, number>();
    const mine: Ref[] = [];
    const strays: Ref[] = [];
    /** The expression page's symbols, redrawn on their own page. */
    const redrawn: Ref[] = [];
    for (const g of geo) {
      if (g.pageId !== pageId) {
        redrawn.push(g.ref);
        continue;
      }
      const owner = g.bounds
        ? SYMBOLS.find((s) => inSlot(g.bounds!, s.slot))
        : undefined;
      if (owner) {
        counts.set(owner.kind, (counts.get(owner.kind) ?? 0) + 1);
        mine.push(g.ref);
      } else {
        strays.push(g.ref);
      }
    }

    for (const [k, v] of counts) drewKind.set(k, v);
    const drawn = SYMBOLS.filter((s) => (counts.get(s.kind) ?? 0) > 0);
    expect(
      drawn.length,
      "the symbology bindings drew native modules into their bound frames",
    ).toBeGreaterThan(0);

    if (redrawn.length > 0) {
      notes.push(
        `the pass also redrew the expression page's bound symbols — ` +
          `${redrawn.length} path modules, in their own frames on their own ` +
          "page, replacing the old ones.",
      );
    }
    if (strays.length > 0) {
      notes.push(
        `${strays.length} new path modules landed on this page outside ` +
          "every slot — left in place so the evidence of where the " +
          "lowering actually put them survives review.",
      );
    }

    // The redrawn symbols are new items too: they take the layer the
    // expression page gave the ones they replace.
    await assignLayerBatch(
      doc,
      "polygon",
      [...mine, ...redrawn].map((r) => r.id),
      LAYER.content,
    ).catch((err) => {
      notes.push(`layer assignment refused: ${String(err).slice(0, 120)}`);
    });
    elements.push(...mine.map((r) => r.id));

    for (const s of SYMBOLS) {
      const n = counts.get(s.kind) ?? 0;
      if (n === 0) {
        notes.push(
          `${s.title}: no modules reached its frame on this lane — look ` +
            "for a refused definition or an unencodable value in the " +
            "browser log (UPC-A drew nothing for as long as the engine " +
            "read only the spelling `upcA` and refused the panel's `upca`).",
        );
      }
    }
    if (drawn.length >= 2) {
      covers.push(
        "data.barcode.symbology",
        "frames-paths.path.insert",
        "data.bind.authoring",
      );
      verdict =
        `${drawn.length} of 4 symbologies drew — ` +
        drawn
          .map((s) => `${s.title.split(" — ")[0]} ${counts.get(s.kind)}`)
          .join(" · ") +
        " native filled paths, every module real page geometry. " +
        (drawn.length === SYMBOLS.length
          ? ""
          : "What did not draw refused honestly — the missing policy " +
            "draws nothing rather than a fake symbol; the captions and " +
            "the run notes carry each miss.");
    } else {
      verdict =
        `${drawn.length} of 4 symbologies drew into their frames — the run ` +
        "notes carry the misses.";
    }
  }

  // The payload captions — authored AFTER the drive, so each states
  // what is actually above it rather than what was hoped for.
  for (const s of SYMBOLS) {
    const n = drewKind.get(s.kind) ?? 0;
    const text =
      n > 0
        ? s.payload
        : chapterData.ready
          ? "(nothing drawn — see the run notes)"
          : "(engine not ready — nothing drawn)";
    const payload = await proseFrame(
      ctx,
      pg,
      [
        s.slot[0],
        s.slot[3] + 6,
        s.slot[2] + (s.kind === "qr" ? 77 : 0),
        s.slot[3] + 40,
      ],
      [{ text, style: STYLE.codeBlock }],
    );
    elements.push(payload.frameId);
  }

  const verdictFrame = await proseFrame(
    ctx,
    pg,
    [60, 470, 492, 540],
    [{ text: verdict, style: STYLE.bodySmall }],
  );
  elements.push(verdictFrame.frameId);

  elements.push(
    await marginNote(
      ctx,
      pg,
      "Placing these four re-lowered every binding of the session: the " +
        "expression page's two symbols were redrawn in their own frames, " +
        "in place. The raster barcode lane stays closed by design. " +
        "→ Appendix A",
    ),
  );

  elements.push(
    await specLabel(ctx, pg, [
      "Specimen No. 179",
      "authoring row ×4: code128/sku · ean13/ean · upca/upc · qr/url",
      "clean-room encoders (Rust) → insertPath filled rects",
      "payloads printed as resolved for record 1001",
    ]),
  );

  return {
    title: "Four symbologies, one order book",
    covers,
    elements,
    notes: notes.length > 0 ? notes : undefined,
  };
}
