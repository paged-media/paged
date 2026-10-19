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

// The text editor's input surface (F-36, ADR 234).
//
// While a caret is in a story, keyboard focus sits on this textarea, laid
// over the canvas at the caret. It is what an operating system's input
// method talks to: an IME composition, a dead key (´ then e → é), Option
// or AltGr characters, the emoji picker, dictation — none of them is a
// plain keydown, and none had a target before, so all of them were lost.
// `useTextEditing` reads the text from the textarea's `beforeinput` and
// composition events and inserts it into the story; the textarea itself
// stays empty.
//
// It is invisible except while an input method composes: then it shows
// the marked (uncommitted) text at the caret, underlined, and because it
// sits at the caret, the IME's candidate window opens there too.

import { useState, type CSSProperties } from "react";

import type { Camera, CaretGeometry, PageId } from "@paged-media/client";
import { CANVAS_SURFACE_ATTR, useContentSelection } from "@paged-media/shell";

import type { PageRect } from "./layout";

export interface TextInputSurfaceProps {
  camera: Camera;
  pageIds: ReadonlyArray<PageId>;
  pageRects: ReadonlyArray<PageRect>;
}

/** The surface's element, while one is mounted. */
export function textInputSurface(): HTMLTextAreaElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLTextAreaElement>(
    `textarea[${CANVAS_SURFACE_ATTR}="text"]`,
  );
}

/** Where the caret is on screen, in the viewport's CSS pixels. */
export function caretScreenBox(
  caret: CaretGeometry | null,
  camera: Camera,
  pageIds: ReadonlyArray<PageId>,
  pageRects: ReadonlyArray<PageRect>,
): { left: number; top: number; height: number } | null {
  if (!caret) return null;
  const index = pageIds.indexOf(caret.pageId);
  const page = index >= 0 ? pageRects[index] : undefined;
  if (!page) return null;
  return {
    left: (page.x + caret.xPt) * camera.scale + camera.tx,
    top: (page.y + caret.topPt) * camera.scale + camera.ty,
    height: Math.max(caret.heightPt * camera.scale, 8),
  };
}

export function TextInputSurface(props: TextInputSurfaceProps) {
  const { caret, contentSelection } = useContentSelection();
  const [composing, setComposing] = useState(false);
  const box = caretScreenBox(
    caret,
    props.camera,
    props.pageIds,
    props.pageRects,
  );
  const height = box?.height ?? 16;
  const fontSize = Math.min(Math.max(height * 0.75, 11), 48);

  return (
    <textarea
      {...{ [CANVAS_SURFACE_ATTR]: "text" }}
      aria-label="Story text"
      // Reached by focus from the canvas, never by Tab: the caret IS the
      // place the user is, and Tab there types a tab.
      tabIndex={-1}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      rows={1}
      data-composing={composing ? "true" : undefined}
      data-caret-active={contentSelection ? "true" : undefined}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onBlur={() => setComposing(false)}
      style={{
        ...surfaceStyle,
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        height,
        fontSize,
        lineHeight: `${height}px`,
        ...(composing ? composingStyle : hiddenStyle),
      }}
    />
  );
}

const surfaceStyle: CSSProperties = {
  position: "absolute",
  zIndex: 5,
  margin: 0,
  padding: "0 2px",
  border: "none",
  resize: "none",
  overflow: "hidden",
  whiteSpace: "pre",
  pointerEvents: "none",
  fontFamily: "var(--font-sans)",
  // Grows with the marked text (Chromium, Safari 18.2+); elsewhere the
  // minimum width shows its start.
  fieldSizing: "content",
  minWidth: 2,
  maxWidth: 480,
} as CSSProperties;

const hiddenStyle: CSSProperties = {
  opacity: 0,
  color: "transparent",
  background: "transparent",
  caretColor: "transparent",
  width: 2,
};

const composingStyle: CSSProperties = {
  opacity: 1,
  color: "var(--pg-fg, CanvasText)",
  background: "var(--pg-bg, Canvas)",
  caretColor: "var(--overlay-selection)",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textUnderlineOffset: 3,
  boxShadow: "0 0 0 1px var(--overlay-selection)",
  borderRadius: 2,
};
