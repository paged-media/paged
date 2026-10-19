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
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import {
  GestureSpine,
  canvasKeyYields,
  resolveCursorCss,
  usePaged,
  useRegistryView,
  type CanvasPointerEvent,
} from "@paged-media/shell";

// Concept 1 (Phase 2) — mounts the gesture spine in the canvas app
// and bridges it to ViewportCanvas. Subscribes to the effective tool
// (from the ToolContext stack) and swaps the mounted handler; exposes
// `toolGesture` (the pointer dispatchers + hover cursor) ONLY while
// the effective tool carries a handler — otherwise null, so
// ViewportCanvas runs its proven select/text path untouched.
//
// Also routes keyboard events to the active handler (`onKey` — e.g.
// Escape cancels the Rectangle drag), skipping DOM editables.

export interface ToolGestureDispatch {
  onDown: (e: CanvasPointerEvent) => void;
  onMove: (e: CanvasPointerEvent) => void;
  onUp: (e: CanvasPointerEvent) => void;
  /** Abort an in-flight tool gesture WITHOUT committing (pointer
   *  capture loss / window blur). The pointer-up path commits; this
   *  one rolls back. Delivered as the handler's Escape, the uniform
   *  zero-mutation cancel every draw handler implements (INV-8). */
  onCancel: () => void;
  /** Per-position cursor from the handler's `cursorAt`, resolved to a
   *  CSS string; undefined falls back to the tool's base cursor. */
  hoverCursor?: (e: CanvasPointerEvent) => string | undefined;
}

export function useGestureSpine(): {
  toolGesture: ToolGestureDispatch | null;
  /** CSS cursor for the effective tool, or undefined to keep the
   *  default canvas cursor. */
  cursor: string | undefined;
  /** The effective ToolId — lets the canvas wire tool-specific
   *  behaviour that ISN'T a gesture handler (Hand → pan, Zoom →
   *  click-zoom) through its proven legacy machinery. */
  effectiveTool: string;
} {
  const paged = usePaged();
  const [spine] = useState(() => new GestureSpine());

  // Every render's editor reaches the mounted handler (it holds the
  // spine's live handle, not a snapshot): a handler reads the selection
  // and camera as they are when the pointer moves (GM-2).
  useLayoutEffect(() => {
    spine.setEditor(paged);
  }, [spine, paged]);

  const effectiveTool = paged.tool.effectiveTool;
  const lastReason = paged.tool.lastReason;

  // Activate/deactivate handlers as the effective tool changes. `paged`
  // is read as it is when the swap runs (it carries the registry + client
  // the handler needs); keying on effectiveTool/lastReason keeps the swap
  // aligned with the stack.
  const activate = useEffectEvent(
    (tool: typeof effectiveTool, reason: typeof lastReason) =>
      spine.setEffectiveTool(tool, paged, reason),
  );
  useEffect(() => {
    activate(effectiveTool, lastReason);
  }, [effectiveTool, lastReason]);

  // Keyboard → active handler (Escape cancels an in-flight gesture).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!spine.hasActive()) return;
      if (canvasKeyYields(e)) return;
      spine.key(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [spine]);

  // Tear the handler down on unmount.
  useEffect(() => () => spine.clear(), [spine]);

  // Resolve from the registry (synchronous + correct on the same render
  // the tool changed, before the effect runs), through a view that
  // changes with the registry (ADR 229): a tool registered after the
  // first render resolves.
  const tools = useRegistryView(paged.registries.tools);
  const contribution = tools.get(effectiveTool);
  const hasHandler = contribution?.gesture != null;
  const hasCursorAt = hasHandler;
  const cursor = contribution?.cursor
    ? resolveCursorCss(contribution.cursor)
    : undefined;

  // eslint-disable-next-line no-restricted-syntax -- not a plain binding (ADR 229)
  return useMemo(
    () => ({
      toolGesture: hasHandler
        ? {
            onDown: (e: CanvasPointerEvent) => spine.pointerDown(e),
            onMove: (e: CanvasPointerEvent) => spine.pointerMove(e),
            onUp: (e: CanvasPointerEvent) => spine.pointerUp(e),
            onCancel: () =>
              spine.key(new KeyboardEvent("keydown", { key: "Escape" })),
            hoverCursor: hasCursorAt
              ? (e: CanvasPointerEvent) => {
                  const spec = spine.cursorAt(e);
                  return spec ? resolveCursorCss(spec) : undefined;
                }
              : undefined,
          }
        : null,
      cursor,
      effectiveTool,
    }),
    [hasHandler, hasCursorAt, cursor, effectiveTool, spine],
  );
}
