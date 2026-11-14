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

// SDK Phase 5 / panel-gallery pass — Pathfinder panel.
//
// TWO LIVE ROWS since engine protocol v57 (B-22):
//
//  · SHAPE MODES — Union / Intersect / Subtract / Exclude. Curve-
//    preserving CSG in the Rust apply layer (flo_curves against the
//    actual handles); the panel packs the selection into one
//    `Mutation::PathfinderBoolean` and a single Cmd-Z reverses the whole
//    op via the inner Batch.
//  · PATHFINDERS — Divide / Trim / Merge / Crop / Outline / Minus back.
//    These resolve the planar ARRANGEMENT of the selection (the distinct
//    areas overlapping paths divide the plane into) and operate per
//    face. One mutation each, one undo step each.
//
// ORDERING (the thing Crop and Minus back turn on): the region verbs
// take `elementIds` TOP-TO-BOTTOM, index 0 frontmost. Selection order is
// CLICK order, not stacking order, so the panel reads the real z from
// the scene tree — whose leaves come back in paint order, back to front
// — and reverses it. A selection made bottom-up would otherwise invert
// Crop's cookie cutter and Minus back's survivor silently. (Minus back
// is Illustrator's verb since engine 0.65: the FRONT object minus what is
// behind it, in the front object's paint; 0.64 kept the back one.)
//
// REFUSALS ARE SHOWN. The engine caps the arrangement at 1000 inputs and
// 100 000 faces behind a work budget (engine ADR 1019) and REFUSES past
// any of them — it never truncates. The panel puts
// the engine's reason in the status line, in words (the panel kit's
// refusalText: never the wire's variant name), rather than looking like
// nothing happened.
//
// HONEST SEAMS, still: the CONVERT SHAPE row + the corner option (no
// Operations behind them).
//
// BEFORE THE CLICK (paged.draw ADR 370). The engine has no dry run of
// these operations, so the panel says plainly that a button applies on
// click (one undo step) and, while a button is hovered or focused,
// outlines on the canvas the objects it will take — the one that keeps
// the result (or that Crop cuts with) solid and named, the others dashed
// (`pathfinder-preview.ts`).

import { useEffect, useRef, useState } from "react";

import { StatusLine } from "@paged-media/panel-kit";
import {
  useCanvasClient,
  useOptionalOverlaySignals,
  useSelection,
  Icon,
} from "@paged-media/shell";

import {
  paintOrder,
  runRegionVerb,
  runShapeMode,
  topToBottom,
  type PathfinderRegionVerb,
} from "../pathfinder-commands";
import {
  operandPreview,
  specialRole,
  type OperandBox,
  type PathfinderOp,
} from "./pathfinder-preview";
import { CoreCommandButton } from "../core-command-dialog";
import { CORE_COMMAND_ENTRIES } from "../core-command-entries";
import { defineMessages, useStrings } from "@paged-media/strings";
import { KitSelect } from "@paged-media/ui";
import type { ElementId, PathfinderKind } from "@paged-media/client";

interface ButtonDef {
  kind: PathfinderKind;
  icon: string;
  label: string;
  hint: string;
}

interface RegionDef {
  verb: PathfinderRegionVerb;
  icon: string;
  label: string;
  hint: string;
}

const M = defineMessages("app.pathfinderPanel", {
  union: "Union",
  unionHint: "Combine paths (Union)",
  intersect: "Intersect",
  intersectHint: "Keep overlap (Intersect)",
  subtract: "Subtract",
  subtractHint: "Top minus rest (Subtract)",
  exclude: "Exclude",
  excludeHint: "Symmetric difference (Exclude)",
  divide: "Divide",
  divideHint: "Every overlapping area becomes its own object (Divide)",
  trim: "Trim",
  trimHint: "Clip each object to the part nothing above it covers (Trim)",
  merge: "Merge",
  mergeHint: "Trim, then combine objects that share a fill (Merge)",
  crop: "Crop",
  cropHint: "Keep only what falls inside the frontmost object (Crop)",
  outline: "Outline",
  outlineHint: "Turn fills into stroked lines along every edge (Outline)",
  minusBack: "Minus back",
  minusBackHint: "The frontmost object minus everything behind it (Minus back)",
  toRectangle: "Convert to rectangle",
  toEllipse: "Convert to ellipse",
  toPolygon: "Convert to polygon",
  toLine: "Convert to line",
  seam: "{hint} — awaiting engine support",
  shapeModes: "Shape modes",
  pathfinders: "Pathfinders",
  selectTwo: "Select 2 or more frames to combine.",
  paths: "Paths",
  convertShape: "Convert shape",
  corner: "Corner",
  cornerSample: "Rounded · 4 pt",
  appliesOnClick:
    "{count, plural, one {Applies on click to # object} other {Applies on click to # objects}} · one undo step. Point at a button to see what it takes.",
  roleResult: "Keeps the result",
  roleKept: "Kept",
  roleCutter: "Cuts the others",
});

/** The overlay layer the operands are outlined on. */
const PREVIEW_LAYER = "paged.pathfinder.operands";

// Icon + 9.5px label tiles in the deep1 3×2 grid (glyph stand-ins
// from the existing registry). `label` and `hint` are message keys.
const BUTTONS: ButtonDef[] = [
  {
    kind: "union",
    icon: "panel-pathfinder",
    label: M.union,
    hint: M.unionHint,
  },
  {
    kind: "intersect",
    icon: "tool-ellipse",
    label: M.intersect,
    hint: M.intersectHint,
  },
  {
    kind: "subtract",
    icon: "tool-erase",
    label: M.subtract,
    hint: M.subtractHint,
  },
  {
    kind: "exclude",
    icon: "tool-scissors",
    label: M.exclude,
    hint: M.excludeHint,
  },
];

const REGION_BUTTONS: RegionDef[] = [
  {
    verb: "pathfinderDivide",
    icon: "ui-grid",
    label: M.divide,
    hint: M.divideHint,
  },
  {
    verb: "pathfinderTrim",
    icon: "tool-scissors",
    label: M.trim,
    hint: M.trimHint,
  },
  {
    verb: "pathfinderMerge",
    icon: "ui-component",
    label: M.merge,
    hint: M.mergeHint,
  },
  {
    verb: "pathfinderCrop",
    icon: "tool-crop",
    label: M.crop,
    hint: M.cropHint,
  },
  {
    verb: "pathfinderOutline",
    icon: "panel-outline",
    label: M.outline,
    hint: M.outlineHint,
  },
  {
    verb: "pathfinderMinusBack",
    icon: "tool-marquee-rect",
    label: M.minusBack,
    hint: M.minusBackHint,
  },
];

const SHAPES = [
  { icon: "tool-rectangle", hint: M.toRectangle },
  { icon: "tool-ellipse", hint: M.toEllipse },
  { icon: "tool-polygon", hint: M.toPolygon },
  { icon: "tool-line", hint: M.toLine },
];

const TILE_CLASS =
  "flex flex-col items-center gap-[5px] rounded-[7px] border border-input " +
  "bg-background px-1 py-[9px] hover:bg-muted/60 disabled:opacity-50";

// The path verbs plus opacity mask and step-and-repeat (their menu groups
// split when the Object menu got real submenus).
const PATH_ENTRIES = CORE_COMMAND_ENTRIES.filter(
  (e) => e.group === "path" || e.group === "clip" || e.group === "duplicate",
);

export function PathfinderPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { elementSelection, setElementSelection } = useSelection();
  const [status, setStatus] = useState<string | null>(null);
  const enabled = elementSelection.length >= 2;
  const signals = useOptionalOverlaySignals();
  // The hover the outline answers; a newer hover (or leaving) wins.
  const previewSeq = useRef(0);

  /** Outline what `op` will take (or clear it, `op` null). */
  const preview = (op: PathfinderOp | null) => {
    const seq = ++previewSeq.current;
    if (!signals) return;
    if (!op || !enabled) {
      signals.removeOverlayLayer(PREVIEW_LAYER);
      return;
    }
    const ids = [...elementSelection] as ElementId[];
    void Promise.all([
      client.elementGeometry(ids),
      client.sceneTree().catch(() => []),
    ])
      .then(([geometry, tree]) => {
        if (seq !== previewSeq.current) return;
        const same = (a: ElementId, b: ElementId) =>
          a.kind === b.kind && String(a.id) === String(b.id);
        const boxes: OperandBox[] = ids.flatMap((id, i) => {
          // The reply follows the request's order; match by id all the
          // same (an id the engine dropped leaves a gap).
          const g =
            geometry[i] && same(geometry[i].id, id)
              ? geometry[i]
              : geometry.find((x) => same(x.id, id));
          return g?.pageId && g.bounds
            ? [{ id, pageId: g.pageId, bounds: g.bounds }]
            : [];
        });
        const front = topToBottom(ids, paintOrder(tree))[0] ?? null;
        const role = specialRole(op)?.role ?? null;
        const label =
          role === "result"
            ? strings.t(M.roleResult)
            : role === "kept"
              ? strings.t(M.roleKept)
              : role === "cutter"
                ? strings.t(M.roleCutter)
                : null;
        signals.setOverlayLayer(
          PREVIEW_LAYER,
          operandPreview(op, boxes, front, label) as never,
        );
      })
      .catch(() => {
        /* no outline: the click still says what it did */
      });
  };
  // The outline goes with the panel. The remover is stable; the signals
  // object itself changes with every overlay update (a cleanup keyed on it
  // would take the outline down as soon as it was drawn).
  const removeLayer = signals?.removeOverlayLayer;
  useEffect(
    () => () => {
      removeLayer?.(PREVIEW_LAYER);
    },
    [removeLayer],
  );

  const deps = {
    client,
    getSelection: () => elementSelection as ElementId[],
    setSelection: async (ids: ElementId[]) => {
      const applied = await client.setElementSelection(ids, "replace");
      setElementSelection(applied);
    },
  };

  async function run(kind: PathfinderKind, label: string) {
    if (!enabled) return;
    setStatus(null);
    setStatus(await runShapeMode(deps, kind, label));
  }

  /** One region verb over the selection, ordered by real z. */
  async function runRegion(verb: PathfinderRegionVerb, label: string) {
    if (!enabled) return;
    setStatus(null);
    setStatus(await runRegionVerb(deps, verb, label));
  }

  return (
    <div className="p-3 flex flex-col gap-2" data-pathfinder-panel="ready">
      <div className="pg-label">{strings.t(M.shapeModes)}</div>
      <div
        className="grid grid-cols-4 gap-[6px]"
        role="group"
        aria-label={strings.t(M.shapeModes)}
      >
        {BUTTONS.map((btn) => (
          <button
            type="button"
            key={btn.kind}
            data-pathfinder-kind={btn.kind}
            data-applies-on-click=""
            disabled={!enabled}
            title={strings.t(btn.hint)}
            className={TILE_CLASS}
            onPointerEnter={() => preview(btn.kind)}
            onPointerLeave={() => preview(null)}
            onFocus={() => preview(btn.kind)}
            onBlur={() => preview(null)}
            onClick={() => {
              preview(null);
              void run(btn.kind, strings.t(btn.label));
            }}
          >
            <Icon
              name={btn.icon}
              size={17}
              style={{ color: "var(--pg-muted-fg)" }}
            />
            <span className="text-[9.5px]" style={{ color: "var(--pg-fg)" }}>
              {strings.t(btn.label)}
            </span>
          </button>
        ))}
      </div>
      <div className="pg-label pt-1">{strings.t(M.pathfinders)}</div>
      <div
        className="grid grid-cols-3 gap-[6px]"
        role="group"
        aria-label={strings.t(M.pathfinders)}
      >
        {REGION_BUTTONS.map((btn) => (
          <button
            type="button"
            key={btn.verb}
            data-pathfinder-verb={btn.verb}
            data-applies-on-click=""
            disabled={!enabled}
            title={strings.t(btn.hint)}
            className={TILE_CLASS}
            onPointerEnter={() => preview(btn.verb)}
            onPointerLeave={() => preview(null)}
            onFocus={() => preview(btn.verb)}
            onBlur={() => preview(null)}
            onClick={() => {
              preview(null);
              void runRegion(btn.verb, strings.t(btn.label));
            }}
          >
            <Icon
              name={btn.icon}
              size={17}
              style={{ color: "var(--pg-muted-fg)" }}
            />
            <span className="text-[9.5px]" style={{ color: "var(--pg-fg)" }}>
              {strings.t(btn.label)}
            </span>
          </button>
        ))}
      </div>
      {enabled ? (
        <div
          className="text-xs text-muted-foreground"
          data-pathfinder-applies
          style={{ lineHeight: 1.5 }}
        >
          {strings.t(M.appliesOnClick, { count: elementSelection.length })}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground" data-pathfinder-hint>
          {strings.t(M.selectTwo)}
        </div>
      )}
      <StatusLine tone="warn" attr="data-pathfinder-error">
        {status}
      </StatusLine>
      {/* ADR 323 §4 — the path verbs as typed core commands: point
          edits, close / join, outline stroke, offset, faces, type on a
          path, opacity masks, step and repeat. Each opens the generated
          form prefilled from the selection; Run = one undo step. */}
      <div className="pg-label pt-2 border-t border-input">
        {strings.t(M.paths)}
      </div>
      <div className="flex flex-wrap gap-[5px]" data-path-commands="">
        {PATH_ENTRIES.map((e) => (
          <CoreCommandButton
            key={e.op}
            op={e.op}
            label={e.title.replace(/^[^:]+:\s*/, "").replace(/…$/, "")}
            title={e.title}
            testId={`path-${e.op}`}
            disabled={!elementSelection.length}
            prefill={e.prefill}
          />
        ))}
      </div>
      {/* Engine gap — no convert-shape / corner-option Operations. */}
      <div className="pg-label pt-2 border-t border-input">
        {strings.t(M.convertShape)}
      </div>
      <div className="flex gap-[5px]" data-convert-shape-seam>
        {SHAPES.map((s) => (
          <button
            key={s.icon}
            type="button"
            disabled
            data-seam
            title={strings.t(M.seam, { hint: strings.t(s.hint) })}
            className="w-[34px] h-[30px] rounded-[6px] border border-input bg-background text-muted-foreground opacity-55 flex items-center justify-center"
          >
            <Icon name={s.icon} size={16} />
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[84px_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {strings.t(M.corner)}
        </span>
        <KitSelect
          aria-label={strings.t(M.corner)}
          value=""
          soft
          disabled
          data-seam
        >
          <option value="">{strings.t(M.cornerSample)}</option>
        </KitSelect>
      </div>
    </div>
  );
}
