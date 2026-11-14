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

// Editing aid "Hidden characters" (editor ADR "Editing aids and Proof
// view", amended; engine ADR 1306): InDesign's Type ▸ Show Hidden
// Characters — a raised dot for a space, » for a tab, ¶ for a paragraph
// return, ¬ for a forced line break, # where a story ends — over the text,
// in the violet of nonprinting structure. Off by default. The host mounts
// it only while the aid is on and the view is not a proof.
//
// The engine says where the invisibles stand (`hiddenCharacters`: per page,
// per composed line, each mark's x on the line, the line's baseline, text
// size and turn); this draws them. Only the pages in view are asked for,
// again when the view brings others in or the document changes. A line is
// at most two SVG text runs (the centred marks of its spaces, the marks
// that start where they stand), so a page of text stays a few hundred
// nodes; zoomed out past legibility nothing is drawn.

import { useEffect, useRef, useState } from "react";

import {
  changesTheDocument,
  viewportToDoc,
  type HiddenCharacter,
  type HiddenCharacterKind,
  type HiddenCharacterLine,
  type PageHiddenCharacters,
  type PageId,
} from "@paged-media/client";

import type {
  OverlayContribution,
  OverlayPageRect,
  OverlayProps,
} from "../registries/overlay";
import { useCamera } from "../state/camera-context";
import { useCanvasClient } from "../state/canvas-client-context";

/** Each invisible's mark: InDesign's where it has one. */
export const HIDDEN_CHARACTER_GLYPHS: Readonly<
  Record<HiddenCharacterKind, string>
> = {
  space: "·",
  nonBreakingSpace: "°",
  fixedSpace: "·",
  tab: "»",
  forcedLineBreak: "¬",
  discretionaryLineBreak: "|",
  anchoredObject: "⚓",
  paragraphEnd: "¶",
  columnBreak: "▼",
  frameBreak: "⇓",
  pageBreak: "↓",
  oddPageBreak: "↓",
  evenPageBreak: "↓",
  storyEnd: "#",
};

/** Marks drawn centred in the width their character takes. */
const CENTRED: ReadonlySet<HiddenCharacterKind> = new Set([
  "space",
  "nonBreakingSpace",
  "fixedSpace",
]);

/** Below this size on screen (CSS px) the marks are not drawn: they would
 *  read as a grey fill, not as characters (semantic zoom, UXI-CAM-017). */
export const HIDDEN_CHARACTERS_MIN_PX = 4;

/** One line's marks as at most two SVG text runs: the marks centred in
 *  their character's width (spaces) and the marks that start where they
 *  stand. Each run lists its glyphs and the x of each, in the line's
 *  upright coordinates. Pure. */
export function hiddenCharacterRuns(marks: readonly HiddenCharacter[]): {
  centred: { text: string; xs: number[] };
  start: { text: string; xs: number[] };
} {
  const centred = { text: "", xs: [] as number[] };
  const start = { text: "", xs: [] as number[] };
  for (const m of marks) {
    const glyph = HIDDEN_CHARACTER_GLYPHS[m.kind];
    if (!glyph) continue;
    if (CENTRED.has(m.kind)) {
      centred.text += glyph;
      centred.xs.push(m.x + m.width / 2);
    } else {
      start.text += glyph;
      start.xs.push(m.x);
    }
  }
  return { centred, start };
}

/** The pages whose rectangle meets the viewport, in page order. */
export function pagesInView(
  pageRects: ReadonlyMap<PageId, OverlayPageRect>,
  camera: OverlayProps["camera"],
  viewport: readonly [number, number],
): PageId[] {
  const [w, h] = viewport;
  if (!(w > 0 && h > 0) || !(camera.scale > 0)) return [...pageRects.keys()];
  const corners = [
    viewportToDoc(camera, 0, 0),
    viewportToDoc(camera, w, 0),
    viewportToDoc(camera, w, h),
    viewportToDoc(camera, 0, h),
  ];
  const x0 = Math.min(...corners.map((c) => c[0]));
  const x1 = Math.max(...corners.map((c) => c[0]));
  const y0 = Math.min(...corners.map((c) => c[1]));
  const y1 = Math.max(...corners.map((c) => c[1]));
  const out: PageId[] = [];
  for (const [id, r] of pageRects) {
    if (r.x <= x1 && r.x + r.w >= x0 && r.y <= y1 && r.y + r.h >= y0)
      out.push(id);
  }
  return out;
}

/** The pages' marks, or null when the read failed or a newer one started.
 *  Outside the component: no conditional in a `try` (ADR 229). */
async function readMarks(
  client: ReturnType<typeof useCanvasClient>,
  pageIds: readonly PageId[],
  current: () => boolean,
): Promise<PageHiddenCharacters[] | null> {
  if (pageIds.length === 0) return [];
  try {
    const pages = await client.hiddenCharacters(pageIds);
    return current() ? pages : null;
  } catch {
    return null;
  }
}

function LineMarks({ line }: { line: HiddenCharacterLine }) {
  const { centred, start } = hiddenCharacterRuns(line.marks);
  const t = line.turn;
  return (
    <g
      transform={t ? `matrix(${t.join(" ")})` : undefined}
      fontSize={line.size}
    >
      {centred.text && (
        <text
          x={centred.xs.join(" ")}
          y={line.baseline}
          textAnchor="middle"
          data-hidden-run="centred"
        >
          {centred.text}
        </text>
      )}
      {start.text && (
        <text x={start.xs.join(" ")} y={line.baseline} data-hidden-run="start">
          {start.text}
        </text>
      )}
    </g>
  );
}

function HiddenCharactersRender(props: OverlayProps) {
  const client = useCanvasClient();
  const { viewportSize } = useCamera();
  const [pages, setPages] = useState<PageHiddenCharacters[]>([]);
  const runRef = useRef(0);
  const inView = pagesInView(props.pageRects, props.camera, viewportSize);
  // One string per distinct set of pages: the read follows the set, not
  // every camera frame.
  const inViewKey = inView.join("\n");

  useEffect(() => {
    const ids = inViewKey ? (inViewKey.split("\n") as PageId[]) : [];
    const refresh = () => {
      const run = ++runRef.current;
      void readMarks(client, ids, () => run === runRef.current).then((read) => {
        if (read) setPages(read);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (
        changesTheDocument(msg) ||
        msg.kind === "gestureCancelled" ||
        (msg.kind === "viewSettingsApplied" && msg.payload.rebuilt === true)
      )
        refresh();
    });
  }, [client, inViewKey]);

  let count = 0;
  const kinds = new Set<string>();
  for (const p of pages)
    for (const l of p.lines)
      for (const m of l.marks) {
        count++;
        kinds.add(m.kind);
      }
  const scale = props.camera.scale;
  return (
    <g
      data-hidden-characters={count}
      data-hidden-kinds={[...kinds].sort().join(" ")}
      fill="var(--overlay-guide)"
      fontFamily="system-ui, sans-serif"
      pointerEvents="none"
    >
      {pages.map((p) => {
        const r = props.pageRects.get(p.pageId);
        if (!r) return null;
        return (
          <g
            key={p.pageId}
            data-hidden-page={p.pageId}
            transform={`translate(${r.x} ${r.y})`}
          >
            {p.lines.map((line, i) =>
              line.size * scale < HIDDEN_CHARACTERS_MIN_PX ? null : (
                <LineMarks key={i} line={line} />
              ),
            )}
          </g>
        );
      })}
    </g>
  );
}

export const hiddenCharactersContribution: OverlayContribution = {
  id: "paged.overlay.hiddenCharacters",
  render: HiddenCharactersRender,
  // Over the frame edges (45) and the margins (40), under the guides (80)
  // and the selection chrome (200).
  z: 60,
};
