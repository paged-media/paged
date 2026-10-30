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

// The TYPE OVERLAY (WP5.10): while a type layer is being edited, a text
// field sits exactly over its frame on the canvas — in document space,
// inside the overlay host's camera group, so it pans and zooms with the
// page. Its own glyphs are transparent: what shows is the layer itself,
// laid out by the engine and re-rendered as the text changes; the field
// gives the caret, the selection, IME and the keys. Esc (or a click
// elsewhere) ends the session, which is one undo step.

import type { ReactElement } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import type { OverlayProps } from "@paged-media/plugin-api";

import { imageToPage } from "./frame-fit";
import type { ImageSession } from "./session";
import { layoutBox } from "./type-layer";

export function makeTypeOverlay(session: ImageSession) {
  function TypeOverlay(props: OverlayProps): ReactElement | null {
    const live = useLive(session, onDidChangeOf);
    const edit = live.state().typeEdit;
    if (!edit?.fit) return null;
    const src = live.typeLayerSource(edit.index);
    const page = props.pageRects.get(edit.fit.pageId);
    if (!src || !page) return null;
    const box = layoutBox({ ...src, text: edit.text });
    const [x, y] = imageToPage(edit.fit, [box.left, box.top]);
    const scale = edit.fit.scale;
    const run = src.runs[0];
    const align = src.paragraphs[0]?.align ?? "left";
    const textAlign = align.startsWith("justify")
      ? "justify"
      : (align as "left" | "center" | "right");
    const color = run
      ? `rgb(${run.color[0]}, ${run.color[1]}, ${run.color[2]})`
      : "black";
    return (
      <g data-image-type-overlay={edit.index}>
        <rect
          x={page.x + x}
          y={page.y + y}
          width={box.width * scale}
          height={box.height * scale}
          fill="none"
          style={{ stroke: "var(--pg-primary)" }}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        <foreignObject
          x={page.x + x}
          y={page.y + y}
          width={box.width * scale}
          height={box.height * scale}
        >
          <textarea
            data-image-type-editor
            aria-label="Type"
            autoFocus
            spellCheck={false}
            value={edit.text}
            onChange={(e) => void session.setTypeEditText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (
                e.key === "Escape" ||
                (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              ) {
                e.preventDefault();
                session.endTypeEdit();
              }
            }}
            onBlur={() => session.endTypeEdit()}
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: "100%",
              margin: 0,
              padding: 0,
              border: "none",
              outline: "none",
              resize: "none",
              overflow: "hidden",
              background: "transparent",
              color: "transparent",
              caretColor: color,
              fontFamily: run?.font ?? "sans-serif",
              fontSize: `${(run?.size ?? 24) * scale}px`,
              lineHeight: 1.2,
              textAlign,
              whiteSpace: src.frame.kind === "point" ? "pre" : "pre-wrap",
              paddingTop: `${Math.max(0, (box.firstBaseline ?? run?.size ?? 24) - (run?.size ?? 24)) * scale}px`,
            }}
          />
        </foreignObject>
      </g>
    );
  }
  return TypeOverlay;
}
