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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import type {
  CaretGeometry,
  ContentSelection,
  SelectionRect,
} from "@paged-media/client";

import { useCanvasClient } from "./canvas-client-context";

interface ContentSelectionContextValue {
  /** Canonical content selection (story + offsets + affinity). */
  contentSelection: ContentSelection | null;
  /** Setter that round-trips through the worker — every change posts
   * `SetSelection` and refreshes caret + selection geometry. */
  setContentSelection: (sel: ContentSelection | null) => void;

  /** Caret position for the current selection's start offset. */
  caret: CaretGeometry | null;
  setCaret: (caret: CaretGeometry | null) => void;

  /** One rect per visible line covered by the selection range. */
  selectionRects: SelectionRect[];
  setSelectionRects: (rects: SelectionRect[]) => void;

  /** Ref mirroring `contentSelection` so async callbacks (the
   * post-mutation refresh) can read the latest value without
   * closing over a stale state snapshot. */
  contentSelectionRef: React.MutableRefObject<ContentSelection | null>;

  /** The character style chosen at a collapsed caret, kept for the text
   *  typed there (finding PN-152, InDesign's insertion-point style; editor
   *  ADR 236). The engine stores no style on an empty range, so the caret
   *  holds it: the next insert at the caret carries it, and any new
   *  selection drops it. `null` when none was chosen. */
  typingStyle: TypingStyle | null;
  setTypingStyle: (style: TypingStyle | null) => void;
}

/** A character style held for a caret (see `typingStyle`). */
export interface TypingStyle {
  /** The caret it was chosen at. */
  storyId: string;
  offset: number;
  /** The character style's `Self` id. */
  characterStyle: string;
}

const Context = createContext<ContentSelectionContextValue | null>(null);

// The held style, mirrored for the text input path, which inserts from a
// key handler outside React's render (`heldTypingStyle`). One editor, one
// caret: written only by the provider's setter.
let held: TypingStyle | null = null;

/** The character style held for the caret `sel` (finding PN-152), or
 *  `null`: what an insert at that caret applies to the text it adds. */
export function heldTypingStyle(sel: {
  storyId: string;
  start: number;
  end: number;
}): string | null {
  return held &&
    sel.start === sel.end &&
    held.storyId === sel.storyId &&
    held.offset === sel.start
    ? held.characterStyle
    : null;
}

export function ContentSelectionProvider({ children }: PropsWithChildren) {
  const client = useCanvasClient();
  const [contentSelection, setContentSelectionRaw] =
    useState<ContentSelection | null>(null);
  const [caret, setCaret] = useState<CaretGeometry | null>(null);
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);
  const contentSelectionRef = useRef<ContentSelection | null>(null);
  const [typingStyle, setTypingStyleRaw] = useState<TypingStyle | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- the component is not compiled yet (compiler-coverage.json) (ADR 229)
  const setTypingStyle = useCallback((style: TypingStyle | null) => {
    held = style;
    setTypingStyleRaw(style);
  }, []);
  // Written during render on purpose: the caret reader handed to plugins
  // (`getEditor().contentSelection.contentSelectionRef`) may be read by a
  // panel while it renders. It keeps this provider uncompiled (ADR 229).
  contentSelectionRef.current = contentSelection;

  // eslint-disable-next-line no-restricted-syntax -- the component is not compiled yet (compiler-coverage.json) (ADR 229)
  const setContentSelection = useCallback(
    (sel: ContentSelection | null) => {
      setContentSelectionRaw(sel);
      // A new selection is a new insertion point: the style held for the
      // old caret goes (an insert applies it before it moves the caret).
      setTypingStyle(null);
      void client.setSelection(sel);
      if (sel) {
        void client
          .caretGeometry(sel)
          .then(setCaret)
          .catch(() => setCaret(null));
        if (sel.start !== sel.end) {
          void client
            .selectionGeometry(sel)
            .then(setSelectionRects)
            .catch(() => setSelectionRects([]));
        } else {
          setSelectionRects([]);
        }
      } else {
        setCaret(null);
        setSelectionRects([]);
      }
    },
    [client, setTypingStyle],
  );

  // eslint-disable-next-line no-restricted-syntax -- the component is not compiled yet (compiler-coverage.json) (ADR 229)
  const value = useMemo<ContentSelectionContextValue>(
    () => ({
      contentSelection,
      setContentSelection,
      caret,
      setCaret,
      selectionRects,
      setSelectionRects,
      contentSelectionRef,
      typingStyle,
      setTypingStyle,
    }),
    [
      contentSelection,
      setContentSelection,
      caret,
      selectionRects,
      typingStyle,
      setTypingStyle,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useContentSelection(): ContentSelectionContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      "useContentSelection called outside ContentSelectionProvider",
    );
  }
  return ctx;
}
