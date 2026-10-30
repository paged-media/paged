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

// THE 9-SLICE GUIDES tool (WP6.8, draw ADR 365) — Illustrator edits a
// symbol's 9-slice guides in symbol editing mode; the engine has no
// isolation mode, so this tool IS that mode for the guides: select an
// instance and the tool draws its symbol's four guides where the engine
// cuts (`nineSliceGuides`, through the instance's own scale), a drag
// moves one, and the release writes the SYMBOL's guides
// (`redefineSymbol { nineSlice }`) — one undo step, and every instance
// of the symbol follows, as in Illustrator. A symbol without guides shows
// the default ones (a quarter in from each side) dashed; dragging one
// turns them on.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  defaultNineSlice,
  nineSliceDrag,
  nineSliceGuideAt,
  nineSliceGuides,
  symbolismQuad,
  type NineSliceGuide,
} from "@paged-media/draw-geometry";

import {
  engineSymbolOptions,
  instancesIn,
  readEngineSymbols,
  readInstanceStates,
  type InstanceState,
} from "../commands/symbols-engine";
import { polyShape } from "./preview-shapes";
import { serial } from "./serial";

/** How near a press must be to take a guide: 6 screen px, in pt at the
 *  current zoom (6 pt where the host has no viewport). */
export const NINE_SLICE_PICK_PX = 6;

const pickTolerance = (host: BundleHost): number => {
  try {
    const pt = host.viewport.pxToPt(NINE_SLICE_PICK_PX);
    return Number.isFinite(pt) && pt > 0 ? pt : NINE_SLICE_PICK_PX;
  } catch {
    return NINE_SLICE_PICK_PX;
  }
};

interface Session {
  state: InstanceState;
  symbolId: string;
  insets: [number, number, number, number];
  /** Whether the symbol has guides yet. */
  enabled: boolean;
}

export function createNineSliceHandler(
  host: BundleHost,
  hooks: { onCommit?: (applied: boolean) => void } = {},
): GestureHandler {
  const queue = serial(host, "9-slice guides");
  let session: Session | null = null;
  let drag: NineSliceGuide | null = null;
  let sub: Disposable | null = null;

  const load = async (): Promise<Session | null> => {
    const [id] = instancesIn(host.selection.get());
    if (!id) return null;
    const [state] = await readInstanceStates(host, [id]);
    if (!state?.symbol) return null;
    const symbol = (await readEngineSymbols(host)).find(
      (s) => s.id === state.symbol,
    );
    if (!symbol) return null;
    return {
      state,
      symbolId: symbol.id,
      insets: symbol.nineSlice
        ? [...symbol.nineSlice]
        : defaultNineSlice(state.box),
      enabled: symbol.nineSlice !== null,
    };
  };

  const draw = () => {
    if (!session) {
      host.overlay.setToolPreviews(null);
      return;
    }
    const { state, insets, enabled } = session;
    const page = state.pageId;
    const shapes: ToolPreviewShape[] = [
      polyShape(
        page,
        symbolismQuad({
          matrix: state.matrix,
          box: state.box,
          tint: null,
          opacity: 100,
        }),
        { close: true, dashed: true },
      ),
      ...nineSliceGuides(state.box, insets, state.matrix).map(([a, b]) =>
        polyShape(page, [a, b], { dashed: !enabled }),
      ),
    ];
    host.overlay.setToolPreviews(shapes);
  };

  const refresh = () =>
    queue.run(async () => {
      if (drag !== null) return;
      session = await load();
      draw();
    });

  return {
    onActivate() {
      sub?.dispose();
      sub = host.selection.onDidChange(refresh);
      refresh();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      sub?.dispose();
      sub = null;
      session = null;
      drag = null;
      host.overlay.setToolPreviews(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pagePoint) return;
      const p = e.pagePoint;
      queue.run(async () => {
        session ??= await load();
        if (!session) {
          host.log.warn(
            "9-slice guides: select a symbol instance to edit its symbol's guides",
          );
          return;
        }
        if (e.pageId !== session.state.pageId) return;
        drag = nineSliceGuideAt(
          p,
          session.state.box,
          session.insets,
          session.state.matrix,
          pickTolerance(host),
        );
        draw();
      });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      const p = e.pagePoint;
      queue.run(async () => {
        if (!session || drag === null) return;
        session.insets = nineSliceDrag(
          drag,
          p,
          session.state.box,
          session.insets,
          session.state.matrix,
        );
        session.enabled = true;
        draw();
      });
    },
    onPointerUp() {
      queue.run(async () => {
        if (!session || drag === null) return;
        drag = null;
        const applied = await engineSymbolOptions(
          host,
          "9-slice guides",
          session.symbolId,
          { nineSlice: session.insets },
        );
        hooks.onCommit?.(applied);
        session = await load();
        draw();
      });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      queue.run(async () => {
        drag = null;
        session = await load();
        draw();
      });
    },
  };
}
