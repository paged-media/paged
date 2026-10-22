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

// Panel-gallery pass — the Glyphs panel (InDesign-parity ●●●,
// gallery "Glyphs" card). PARTIALLY LIVE: clicking a glyph with an
// active text caret inserts the character through the real
// `insertText` mutation (undoable, same op the keyboard rides);
// without a caret the grid renders inert (you can't insert into
// nothing). Recently-used is panel-local state.
//
// W2.12 — the Font family select is now fed REAL families from the
// `fonts` collection (the document's fonts-in-use, deduped). It scopes
// the grid's preview font so the inserted/previewed glyph renders in
// the chosen family. The Show scope + style select remain seams (no
// per-style registry on the wire); insert stays via insertText.

import { useState } from "react";

import {
  useCanvasClient,
  useCollection,
  useContentSelection,
} from "@paged-media/shell";
import { KitSelect } from "@paged-media/ui";
import type { FontSummary } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import { insertAt } from "../../ui/useTextEditing";
import { ConceptShell, Row, SeamSelect } from "./concept-kit";

const M = defineMessages("app.conceptGlyphsPanel", {
  insertGlyph: "Insert {glyph}",
  placeCaret: "Place a text caret to insert glyphs",
  target:
    "Insert any glyph of any font: full character map, OpenType-feature filter, alternates flyout, glyph sets — the grid inserts via insertText today; font scope lands with the engine's font registry.",
  show: "Show",
  entireFont: "Entire Font",
  font: "Font",
  documentFont: "Document font",
  regular: "Regular",
  placeCaretHint: "Place a text caret to insert glyphs.",
  recentlyUsed: "Recently used",
  glyphs: "Glyphs",
});

/** The gallery grid — punctuation, legal marks, fractions,
 *  currency; the full character map lands with the font registry. */
const GLYPHS = [
  "–",
  "—",
  "·",
  "“",
  "”",
  "‘",
  "’",
  "…",
  "a",
  "á",
  "à",
  "â",
  "ä",
  "ã",
  "@",
  "&",
  "%",
  "¶",
  "§",
  "†",
  "‡",
  "©",
  "®",
  "™",
  "½",
  "¼",
  "¾",
  "°",
  "€",
  "£",
  "¥",
  "#",
];

export function GlyphsPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { contentSelection, setContentSelection } = useContentSelection();
  const fonts = useCollection<FontSummary>("fonts");
  const [recent, setRecent] = useState<string[]>([]);
  const [family, setFamily] = useState<string>("");
  const caret = contentSelection != null;
  // The grid previews glyphs in the chosen family (real fonts-in-use);
  // empty selection falls back to the serif preview font.
  const previewFont = family
    ? `"${family}", var(--font-serif, serif)`
    : "var(--font-serif, serif)";

  // Findings PN-210 / PN-211: a glyph goes in the way a typed character
  // does — it replaces a selected range and moves the caret past it, so
  // two clicks land in the order clicked.
  const insert = (glyph: string) => {
    if (!contentSelection) return;
    insertAt(client, contentSelection, glyph, setContentSelection);
    setRecent((prev) =>
      [glyph, ...prev.filter((g) => g !== glyph)].slice(0, 8),
    );
  };

  const grid = (glyphs: string[], testId: string) => (
    <div
      className="grid grid-cols-8 gap-[3px]"
      data-glyph-grid={testId}
      data-caret={caret ? "true" : "false"}
    >
      {glyphs.map((g, i) => (
        <button
          key={`${g}-${i}`}
          type="button"
          disabled={!caret}
          data-glyph={g}
          title={
            caret
              ? strings.t(M.insertGlyph, { glyph: g })
              : strings.t(M.placeCaret)
          }
          onClick={() => insert(g)}
          className="aspect-square rounded-[5px] border border-input bg-background text-[15px] leading-none flex items-center justify-center cursor-pointer disabled:cursor-default disabled:opacity-45 hover:bg-muted/60"
          style={{ fontFamily: previewFont }}
        >
          {g}
        </button>
      ))}
    </div>
  );

  return (
    <ConceptShell testId="glyphs-panel" live target={strings.t(M.target)}>
      <Row label={strings.t(M.show)}>
        <SeamSelect value={strings.t(M.entireFont)} />
      </Row>
      <Row label={strings.t(M.font)}>
        <div className="grid grid-cols-[1fr_84px] gap-1">
          {fonts && fonts.length > 0 ? (
            <KitSelect
              soft={family === ""}
              value={family}
              data-glyphs-font
              onChange={(e) => setFamily(e.target.value)}
            >
              <option value="">{strings.t(M.documentFont)}</option>
              {fonts.map((f) => (
                <option key={f.family} value={f.family}>
                  {f.family}
                </option>
              ))}
            </KitSelect>
          ) : (
            <SeamSelect value="—" />
          )}
          {/* Per-style faces aren't on the wire (FontSummary is
              family-only) — the style select stays a seam. */}
          <SeamSelect value={strings.t(M.regular)} />
        </div>
      </Row>
      {!caret && (
        <div className="text-xs text-muted-foreground italic" data-glyphs-hint>
          {strings.t(M.placeCaretHint)}
        </div>
      )}
      {recent.length > 0 && (
        <>
          <div className="pg-label">{strings.t(M.recentlyUsed)}</div>
          {grid(recent, "recent")}
        </>
      )}
      <div className="pg-label">{strings.t(M.glyphs)}</div>
      {grid(GLYPHS, "all")}
    </ConceptShell>
  );
}
