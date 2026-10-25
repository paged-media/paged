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

// The PAINT TOOLS' gesture — the thin host adapter that turns canvas
// pointer events into the brush machine's image-px samples, drives the
// engine's `brush_stroke_*` doors through the session, and draws the
// brush-tip ring through the LIVE host.overlay door. One factory for all
// three tools (`brush` | `pencil` | `eraser`); the tool differs only in
// the wire name handed to the engine, exactly as the three selection
// tools share one gesture.
//
// It owns NO geometry and NO stroke state: the dab planning, the spacing
// walk, the coverage accumulator and the base snapshot are the engine's
// (`crate::stroke`), the sampling policy is the machine's, and this file
// only maps page-local pt ↔ image px (`frame-fit.ts` — the same
// transform the crop tool, the selection tools and the session's Apply
// use) and sequences begin → extend* → commit | cancel.
//
// THE DRAIN PUMP. `brush_stroke_extend` is async — a GPU dispatch plus a
// whole-image readback — and pointer moves arrive faster than it
// resolves. Firing them concurrently would interleave dab order, so the
// pump is a single-flight loop: it takes queued samples one at a time,
// in order, and when the queue is empty AND the pointer is up it
// commits. No sample is dropped (the painted path IS the pointer's
// path); only intermediate preview frames are skipped, which nobody can
// see.

import type {
  BundleHost,
  CanvasPointerEvent,
  CursorSpec,
  DeactivateReason,
  GestureHandler,
  PagedEditor,
  ToolPreviewPolyline,
} from "@paged-media/plugin-api";

import { SAMPLING_TOOLS, type StrokeTool } from "./engine";
import type { ImageSession } from "./session";
import { tipOutline, type BrushPointerType } from "./brush-machine";
import {
  imageToPage,
  pageToImage,
  resolveFrameFit,
  type FitTransform,
} from "./frame-fit";

/** The paint tools' cursor: a crosshair under the tip ring (the ring is
 *  the size affordance, the crosshair marks the dab centre). */
export const PAINT_CURSOR: CursorSpec = { kind: "css", token: "crosshair" };

/** How often a held pointer re-sends its sample (build-up, catch-up). */
export const HOLD_TICK_MS = 50;

/** Smoothing's 100% string length, in screen px. */
export const SMOOTHING_SCREEN_PX = 128;

/** One gesture factory for all three paint tools; `tool` picks the wire
 *  name the engine freezes into the stroke. */
export function makeBrushGesture(
  host: BundleHost,
  session: ImageSession,
  tool: StrokeTool,
): GestureHandler {
  let fit: FitTransform | null = null;
  /** Single-flight guard for the drain loop (see the header note). */
  let pumping = false;
  /** The ENGINE has an open stroke. `brushBegin` is async, and a fast
   *  drag can deliver its whole path before it resolves — so the pump
   *  waits on this rather than extending a stroke that has not begun
   *  (which the session would refuse, aborting the stroke). It is also
   *  re-checked after every await, so a tool switch mid-drag cannot be
   *  followed by a commit. */
  let opened = false;
  /** Bumped by every abandon (Escape, a tool switch): a `brushBegin` that
   *  resolves after its stroke was abandoned closes it instead of
   *  painting. */
  let stroke = 0;

  /** Abandon the stroke in flight: the engine-held pixels were never
   *  mutated, so nothing is lost but the preview. */
  /** BUILD-UP / CATCH-UP: while the pointer is held still the machine
   *  re-queues its last sample on a tick, which the engine reads as time
   *  passing (an airbrush keeps depositing; a smoothed brush catches up
   *  with the pointer). Runs only when one of the two is on. */
  let ticker: ReturnType<typeof setInterval> | null = null;
  let movedSinceTick = false;
  const stopTicker = () => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };
  const startTicker = () => {
    stopTicker();
    const d = session.state().dynamics as
      ReturnType<ImageSession["state"]>["dynamics"] | undefined;
    if (!d) return;
    const holds = d.buildUp || (d.smoothing.amount > 0 && d.smoothing.catchUp);
    if (!holds) return;
    ticker = setInterval(() => {
      const machine = session.brushMachine();
      if (!machine?.state().drawing) return stopTicker();
      if (movedSinceTick) {
        movedSinceTick = false;
        return;
      }
      if (machine.hold()) void pump();
    }, HOLD_TICK_MS);
  };

  /** The pulled string's length in IMAGE px: Smoothing's amount × 128
   *  SCREEN px when zoom-compensated (so it feels the same at every
   *  zoom), × 128 image px otherwise. */
  const smoothingRadiusPx = (): number => {
    const sm = session.state().dynamics?.smoothing;
    if (!sm || sm.amount <= 0) return 0;
    const screen = sm.amount * SMOOTHING_SCREEN_PX;
    if (!sm.zoomCompensation || !fit) return screen;
    const pt = host.viewport.pxToPt(screen);
    return fit.scale > 0 ? pt / fit.scale : screen;
  };

  const abandon = () => {
    stroke++;
    opened = false;
    stopTicker();
    session.brushCancel();
    session.brushMachine()?.cancel();
  };

  /** Publish the brush-tip ring at an image-px point (null clears). The
   *  ring is the NOMINAL tip size mapped into page pt, so it tracks the
   *  canvas zoom the way the pixels do. */
  const renderTip = (point: [number, number] | null) => {
    if (!fit || !point) {
      host.overlay.setToolPreview(null);
      return;
    }
    const ring = tipOutline(point, session.state().brush.size).map((p) =>
      imageToPage(fit, p),
    );
    const shape: ToolPreviewPolyline = {
      pageId: fit.pageId,
      points: ring,
      close: true,
    };
    host.overlay.setToolPreview(shape);
  };

  /** Drain the machine's sample queue into the engine, in order, one at
   *  a time — then commit once the pointer is up and nothing is left. */
  const pump = async () => {
    if (pumping || !opened) return;
    pumping = true;
    try {
      const machine = session.brushMachine();
      if (!machine) return;
      for (;;) {
        if (!opened) return;
        const sample = machine.next();
        if (sample) {
          if (!(await session.brushExtend(sample))) {
            // The engine refused (the session already said why, and
            // already dropped the stroke) — abandon what is queued
            // rather than painting half of it.
            opened = false;
            machine.cancel();
            return;
          }
          continue;
        }
        if (machine.drained()) {
          await session.brushCommit();
          opened = false;
        }
        return;
      }
    } finally {
      pumping = false;
    }
  };

  const ensureFit = async () => {
    fit = await resolveFrameFit(host, session.state().source, `${tool} tool`);
  };

  return {
    onActivate(_paged: PagedEditor) {
      void ensureFit();
    },

    onDeactivate(_reason: DeactivateReason) {
      // A tool switch mid-drag abandons the stroke.
      abandon();
      host.overlay.setToolPreview(null);
      fit = null;
    },

    onPointerDown(e: CanvasPointerEvent) {
      const machine = session.brushMachine();
      if (!machine || !e.pagePoint || !fit) return;
      const point = pageToImage(fit, e.pagePoint);
      // An armed Curves eyedropper takes the click.
      if (session.takeCurvesPick(point)) return;

      // ALT-CLICK SETS THE CLONE SOURCE — Photoshop's convention, and
      // the only interaction the sampling tools add. It is a SEPARATE
      // gesture, not the start of a stroke: falling through to `down`
      // would paint the anchor click, which is the one thing a retoucher
      // never wants.
      if (SAMPLING_TOOLS.includes(tool) && e.modifiers?.alt) {
        session.setCloneSource(point);
        return;
      }
      // ALT-CLICK WITH A PAINT TOOL IS THE EYEDROPPER (Photoshop's
      // convention): it takes the image's colour under the pointer as
      // the foreground, and paints nothing.
      if (e.modifiers?.alt) {
        session.sampleColor(point, 3);
        return;
      }
      if (
        !machine.down(point, e.pressure, e.pointerType as BrushPointerType, {
          tiltX: e.tiltX,
          tiltY: e.tiltY,
        })
      )
        return;
      renderTip(point);
      const mine = ++stroke;
      startTicker();
      void (async () => {
        // The string length crosses only when smoothing is on, so a
        // plain stroke's begin is the one it always was.
        const radius = smoothingRadiusPx();
        const began =
          radius > 0
            ? await session.brushBegin(tool, { smoothingRadiusPx: radius })
            : await session.brushBegin(tool);
        if (!began) {
          if (mine === stroke) machine.cancel();
          return;
        }
        if (mine !== stroke) {
          // Abandoned while it began: close the stroke, paint nothing.
          session.brushCancel();
          return;
        }
        opened = true;
        await pump();
      })();
    },

    onPointerMove(e: CanvasPointerEvent) {
      const machine = session.brushMachine();
      if (!e.pagePoint || !fit) {
        host.overlay.setToolPreview(null);
        return;
      }
      const point = pageToImage(fit, e.pagePoint);
      if (machine?.state().drawing) {
        if (
          machine.move(point, e.pressure, e.pointerType as BrushPointerType, {
            tiltX: e.tiltX,
            tiltY: e.tiltY,
          })
        )
          movedSinceTick = true;
        void pump();
      }
      renderTip(point);
    },

    onPointerUp(_e: CanvasPointerEvent) {
      const machine = session.brushMachine();
      if (!machine || !machine.state().drawing) return;
      stopTicker();
      machine.up();
      void pump();
    },

    // IMG-2 / INV-2: Escape (and a lost pointer capture) mid-stroke
    // commits no stroke; the release that follows finds none drawing.
    onKey(e: KeyboardEvent) {
      const machine = session.brushMachine();
      if (e.key !== "Escape" || !machine?.state().drawing) return;
      abandon();
      host.overlay.setToolPreview(null);
      e.preventDefault();
    },

    cursorAt() {
      return PAINT_CURSOR;
    },
  };
}
