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

// THE LIQUIFY TOOLS — Warp, Twirl, Pucker, Bloat, Scallop, Crystallize
// and Wrinkle: one host-routed shim over draw-tools' `LiquifyMachine`,
// the kernel fixed per tool and every other option read from the tool's
// own options (Illustrator's per-tool dialog: double-click the rail slot).
//
//   hover  → the brush ellipse follows the pointer
//   press  → the targets are read (the selection's paths on the page, or
//            every path on it with nothing selected) and the first step
//            runs; while the button is held a DWELL timer keeps stepping
//            the kernels that act in place (all but Warp), as Illustrator
//            does
//   drag   → a step per sample; the DENSE result is previewed as dashed
//            cubics with the brush
//   release→ the re-fitted paths are written in ONE batch
//            (`commands/distort-shared.ts`): one drag, one undo step
//   Escape → nothing is written
//
// Page space throughout (`readDistortTargets` maps each path through its
// transform; the write maps back).

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import type { LiquifyKind } from "@paged-media/draw-geometry";
import {
  LiquifyMachine,
  type LiquifySnapshot,
  type LiquifyToolOptions,
} from "@paged-media/draw-tools";

import {
  distortTargetsOn,
  writeDistorted,
  type DistortTarget,
} from "../commands/distort-shared";
import {
  createToolOptionsReader,
  LIQUIFY_OPTIONS,
  type ToolOptionsReader,
} from "../tool-options";
import { ellipseShape, tableShapes } from "./preview-shapes";
import { serial } from "./serial";

/** The dwell step interval (ms). */
export const LIQUIFY_DWELL_MS = 60;

/** The machine options a tool's reader holds now. */
export function liquifyOptionsOf(
  kind: LiquifyKind,
  r: ToolOptionsReader,
): LiquifyToolOptions {
  const has = (key: string) =>
    LIQUIFY_OPTIONS[kind].fields.some((f) => f.key === key);
  const num = (key: string, d: number) => (has(key) ? r.number(key) : d);
  const sw = (key: string, d: boolean) =>
    has(key) ? r.select(key) === "on" : d;
  return {
    kind,
    width: r.number("width"),
    height: r.number("height"),
    angle: r.number("angle"),
    intensity: r.number("intensity"),
    usePressure: r.select("usePressure") === "on",
    detail: r.number("detail"),
    simplify: r.number("simplify"),
    twirlRate: num("twirlRate", 40),
    complexity: num("complexity", 1),
    horizontal: num("horizontal", 0),
    vertical: num("vertical", 100),
    affectAnchors: sw("affectAnchors", true),
    affectIn: sw("affectIn", true),
    affectOut: sw("affectOut", true),
  };
}

export function createLiquifyHandler(
  host: BundleHost,
  kind: LiquifyKind,
  hooks: { onCommit?: (changed: number, applied: boolean) => void } = {},
): GestureHandler {
  const reader = createToolOptionsReader(LIQUIFY_OPTIONS[kind]);
  const queue = serial(host, kind);
  let machine: LiquifyMachine | null = null;
  let targets: DistortTarget[] = [];
  let pageId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const reset = () => {
    stopTimer();
    machine = null;
    targets = [];
    host.overlay.setToolPreviews(null);
  };

  const draw = (snap: LiquifySnapshot, page: string) => {
    const shapes: ToolPreviewShape[] = [];
    if (snap.tables)
      for (const t of snap.tables) shapes.push(...tableShapes(page, t));
    if (snap.brush)
      shapes.push(
        ellipseShape(
          page,
          snap.brush.center,
          snap.brush.width / 2,
          snap.brush.height / 2,
          snap.brush.angleDeg,
        ),
      );
    host.overlay.setToolPreviews(shapes.length ? shapes : null);
  };

  const sync = async (snap: LiquifySnapshot) => {
    if (snap.commit && pageId) {
      const commit = snap.commit;
      const owned = targets;
      reset();
      const applied = await writeDistorted(
        host,
        kind,
        commit.map((c) => ({ target: owned[c.index]!, page: c.table })),
      );
      hooks.onCommit?.(commit.length, applied);
      return;
    }
    if (!snap.active) {
      reset();
      hooks.onCommit?.(0, false);
      return;
    }
    if (pageId) draw(snap, pageId);
  };

  const sample = (e: CanvasPointerEvent) => ({
    point: e.pagePoint!,
    pressure: e.pressure,
    pen: e.pointerType === "pen",
  });

  return {
    onActivate(paged) {
      reader.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const s = sample(e);
      queue.run(async () => {
        targets = await distortTargetsOn(host, page, {
          allWhenNoneSelected: true,
        });
        pageId = page;
        const options = liquifyOptionsOf(kind, reader);
        machine = new LiquifyMachine({
          options,
          targets: targets.map((t) => t.page),
        });
        await sync(machine.handle({ type: "down", ...s }));
        if (kind !== "warp" && machine) {
          stopTimer();
          timer = setInterval(() => {
            queue.run(async () => {
              if (machine) await sync(machine.handle({ type: "tick" }));
            });
          }, LIQUIFY_DWELL_MS);
        }
      });
    },
    onPointerMove(e) {
      if (!e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const s = sample(e);
      queue.run(async () => {
        if (machine && page === pageId) {
          await sync(machine.handle({ type: "move", ...s }));
          return;
        }
        if (machine) return;
        // Hover: just the brush.
        const o = liquifyOptionsOf(kind, reader);
        host.overlay.setToolPreviews([
          ellipseShape(page, s.point, o.width / 2, o.height / 2, o.angle),
        ]);
      });
    },
    onPointerUp(e) {
      stopTimer();
      queue.run(async () => {
        stopTimer();
        if (!machine) return;
        const p = e.pageId === pageId ? e.pagePoint : null;
        await sync(
          p
            ? machine.handle({ type: "up", point: p })
            : machine.handle({ type: "key", key: "Escape" }),
        );
      });
    },
    onKey(e) {
      if (e.key !== "Escape") return;
      stopTimer();
      queue.run(async () => {
        if (machine) await sync(machine.handle({ type: "key", key: "Escape" }));
      });
    },
  };
}
