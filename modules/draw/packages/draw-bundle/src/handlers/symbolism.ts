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

// THE SYMBOLISM TOOLS — the Symbol Sprayer, Shifter, Scruncher, Sizer,
// Spinner, Stainer and Screener (WP6.8, draw ADR 365): one host-routed
// shim over draw-tools' `SymbolismMachine`, the kind fixed per tool and
// the brush read from the tool's own options (Illustrator's Symbolism
// Tools Options: double-click the rail slot).
//
//   hover  → the brush circle follows the pointer
//   press  → the instances are read (the selection's on the page, or
//            every instance on it with none selected) and the first step
//            runs; while the button is held a DWELL timer keeps stepping
//            the tools that act in place (Sprayer, Scruncher, Sizer,
//            Stainer, Screener). Alt is Illustrator's inverse: the
//            Sprayer removes what it sweeps, the Scruncher pushes, the
//            Sizer shrinks, the Stainer and Screener take their effect off
//   drag   → a step per sample; the changed and new instances' boxes are
//            previewed with the brush
//   release→ ONE batch (`commands/symbolism.ts`): one drag, one undo step
//   Escape → nothing is written
//
// The tools act on the engine's instances (`document.symbols@1`); on a
// host without them a press only says so.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  SYMBOLISM_DEFAULTS,
  SymbolismMachine,
  type SymbolismSnapshot,
  type SymbolismToolKind,
  type SymbolismToolOptions,
} from "@paged-media/draw-tools";

import {
  symbolBox,
  symbolismScope,
  writeSymbolism,
  type SymbolismScope,
} from "../commands/symbolism";
import { engineSymbols } from "../commands/symbols-engine";
import {
  createToolOptionsReader,
  SYMBOLISM_OPTIONS,
  type ToolOptionsReader,
} from "../tool-options";
import { ellipseShape, polyShape } from "./preview-shapes";
import { serial } from "./serial";

/** The dwell step interval (ms). */
export const SYMBOLISM_DWELL_MS = 80;

/** The machine options a tool's reader holds now. */
export function symbolismOptionsOf(
  kind: SymbolismToolKind,
  r: ToolOptionsReader,
): SymbolismToolOptions {
  const has = (key: string) =>
    SYMBOLISM_OPTIONS[kind].fields.some((f) => f.key === key);
  const num = (key: string, d: number) => (has(key) ? r.number(key) : d);
  return {
    ...SYMBOLISM_DEFAULTS,
    kind,
    diameter: r.number("diameter"),
    intensity: r.number("intensity"),
    density: num("density", SYMBOLISM_DEFAULTS.density),
    sizeScatter: num("sizeScatter", 0),
    rotationScatter: num("rotationScatter", 0),
    followDrag: has("orientation") && r.select("orientation") === "drag",
    color: [num("red", 255) / 255, num("green", 0) / 255, num("blue", 0) / 255],
  };
}

const DWELLS: ReadonlySet<SymbolismToolKind> = new Set([
  "sprayer",
  "scruncher",
  "sizer",
  "stainer",
  "screener",
]);

export function createSymbolismHandler(
  host: BundleHost,
  kind: SymbolismToolKind,
  hooks: {
    onCommit?: (applied: boolean) => void;
    /** The dwell interval (ms); 0 turns the dwell off (specs). */
    dwellMs?: number;
  } = {},
): GestureHandler {
  const dwellMs = hooks.dwellMs ?? SYMBOLISM_DWELL_MS;
  const reader = createToolOptionsReader(SYMBOLISM_OPTIONS[kind]);
  const queue = serial(host, `symbolism ${kind}`);
  let machine: SymbolismMachine | null = null;
  let scope: SymbolismScope | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const reset = () => {
    stopTimer();
    machine = null;
    scope = null;
    host.overlay.setToolPreviews(null);
  };

  const draw = (snap: SymbolismSnapshot, page: string) => {
    const shapes: ToolPreviewShape[] = [];
    for (const q of snap.quads)
      shapes.push(polyShape(page, q, { close: true, dashed: true }));
    for (const q of snap.removing)
      shapes.push(polyShape(page, q, { close: true }));
    if (snap.brush)
      shapes.push(
        ellipseShape(
          page,
          snap.brush.center,
          snap.brush.diameter / 2,
          snap.brush.diameter / 2,
        ),
      );
    host.overlay.setToolPreviews(shapes.length ? shapes : null);
  };

  const sync = async (snap: SymbolismSnapshot) => {
    if (!snap.active) {
      const owned = scope;
      const commit = snap.commit;
      reset();
      // The write is its own statement: inside `hooks.onCommit?.(…)` it
      // would be skipped whenever no hook is given (the live tool).
      const applied =
        commit && owned
          ? await writeSymbolism(host, kind, owned, commit)
          : false;
      hooks.onCommit?.(applied);
      return;
    }
    if (scope) draw(snap, scope.pageId);
  };

  return {
    onActivate(paged) {
      reader.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const point = e.pagePoint;
      const alt = e.modifiers.alt;
      queue.run(async () => {
        if (!engineSymbols(host)) {
          host.log.warn(
            `symbolism ${kind}: this engine keeps no symbols (document.symbols@1) — nothing to act on`,
          );
          return;
        }
        scope = await symbolismScope(host, page);
        if (kind === "sprayer" && !scope.symbol) {
          host.log.warn(
            "Symbol Sprayer: the document has no symbol — define one first",
          );
          scope = null;
          return;
        }
        machine = new SymbolismMachine({
          options: symbolismOptionsOf(kind, reader),
          targets: scope.targets,
          ...(scope.symbol ? { sprayBox: symbolBox(scope.symbol) } : {}),
        });
        await sync(machine.handle({ type: "down", point, alt }));
        if (DWELLS.has(kind) && machine && dwellMs > 0) {
          stopTimer();
          timer = setInterval(() => {
            queue.run(async () => {
              if (machine) await sync(machine.handle({ type: "tick" }));
            });
          }, dwellMs);
        }
      });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const point = e.pagePoint;
      const alt = e.modifiers.alt;
      queue.run(async () => {
        if (machine && scope && page === scope.pageId) {
          await sync(machine.handle({ type: "move", point, alt }));
          return;
        }
        if (machine) return;
        // Hover: just the brush.
        const d = reader.number("diameter");
        host.overlay.setToolPreviews([ellipseShape(page, point, d / 2, d / 2)]);
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      stopTimer();
      queue.run(async () => {
        stopTimer();
        if (!machine) return;
        const p = scope && e.pageId === scope.pageId ? e.pagePoint : null;
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
