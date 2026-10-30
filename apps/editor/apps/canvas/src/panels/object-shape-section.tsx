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

// Editor ADR 310 — the Transform panel's SHAPE section: the live-shape
// parameters of the selected item (engine ADR 1047), Illustrator's
// Transform-panel Shape Properties.
//
//   polygon (live)  Sides (Points for a star) · Star inset %
//   oval            Pie start ° · Pie end ° · Invert pie
//   rectangle       a corner per cell: type + radius, and a link that
//                   writes all four at once
//
// Reads and single writes go through `host.objects` (`useObjectBindings`,
// ADR 323), like the rest of the panel. A write that sets several paths
// at once — the linked radii, a radius that also turns a square corner
// round, Invert pie — is ONE batch through the canvas client, so it is
// one undo step. The section shows only what the one selected item has:
// a polygon that is not live answers no sides, and then nothing shows.

import {
  Icon,
  ObjectFieldFrame,
  useCanvasClient,
  useObjectBindings,
  useSelection,
} from "@paged-media/shell";
import { KitSelect, LengthInput, NumberInput } from "@paged-media/ui";
import { useState } from "react";
import type { ElementId, Mutation, Value } from "@paged-media/client";
import {
  CORNERS,
  MAX_SIDES,
  MAX_STAR_INSET,
  MIN_SIDES,
  type CornerSuffix,
} from "@paged-media/tools";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.objectShapeSection", {
  shape: "Shape",
  sides: "Sides",
  points: "Points",
  starInset: "Star inset",
  pieStart: "Pie start",
  pieEnd: "Pie end",
  invertPie: "Invert pie",
  corners: "Corners",
  linkCorners: "Link corners",
  unlinkCorners: "Unlink corners",
  cornerTopLeft: "Top-left corner",
  cornerTopRight: "Top-right corner",
  cornerBottomRight: "Bottom-right corner",
  cornerBottomLeft: "Bottom-left corner",
  radius: "{corner} radius",
  none: "None",
  rounded: "Rounded",
  inverseRounded: "Inverse rounded",
  bevel: "Bevel",
  inset: "Inset",
  fancy: "Fancy",
});

const BINDINGS = {
  sides: { scope: "element" as const, path: "frameShapeSides" },
  inset: { scope: "element" as const, path: "frameShapeStarInset" },
  pieStart: { scope: "element" as const, path: "frameShapePieStart" },
  pieEnd: { scope: "element" as const, path: "frameShapePieEnd" },
  optTopLeft: { scope: "element" as const, path: "frameCornerOptionTopLeft" },
  optTopRight: { scope: "element" as const, path: "frameCornerOptionTopRight" },
  optBottomRight: {
    scope: "element" as const,
    path: "frameCornerOptionBottomRight",
  },
  optBottomLeft: {
    scope: "element" as const,
    path: "frameCornerOptionBottomLeft",
  },
  radTopLeft: { scope: "element" as const, path: "frameCornerRadiusTopLeft" },
  radTopRight: { scope: "element" as const, path: "frameCornerRadiusTopRight" },
  radBottomRight: {
    scope: "element" as const,
    path: "frameCornerRadiusBottomRight",
  },
  radBottomLeft: {
    scope: "element" as const,
    path: "frameCornerRadiusBottomLeft",
  },
};

/** The corner options, as the wire spells them. */
const OPTIONS = [
  ["None", M.none],
  ["RoundedCorner", M.rounded],
  ["InverseRoundedCorner", M.inverseRounded],
  ["BeveledCorner", M.bevel],
  ["InsetCorner", M.inset],
  ["FancyCorner", M.fancy],
] as const;

const CORNER_NAMES: Record<CornerSuffix, string> = {
  TopLeft: M.cornerTopLeft,
  TopRight: M.cornerTopRight,
  BottomRight: M.cornerBottomRight,
  BottomLeft: M.cornerBottomLeft,
};

/** InDesign draws a corner option with no radius at 12 pt. */
const DEFAULT_RADIUS = 12;

function num(v: Value | null): number | null {
  if (!v || v.type !== "length") return null;
  const n = (v as { value: number | null }).value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function text(v: Value | null): string | null {
  if (!v || v.type !== "text") return null;
  return (v as { value: string }).value;
}

const set = (elementId: ElementId, path: string, value: Value): Mutation =>
  ({
    op: "setElementProperty",
    args: { elementId, path, value },
  }) as Mutation;

export function ObjectShapeSection() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { elementSelection } = useSelection();
  const f = useObjectBindings(BINDINGS);
  const [open, setOpen] = useState(true);
  // Linked unless the user unlinks (UI state, as in InDesign's dialog).
  const [linked, setLinked] = useState(true);
  const one = elementSelection.length === 1 ? elementSelection[0]! : null;
  const kind = one?.kind;

  const sides = num(f.sides.value);
  const inset = num(f.inset.value);
  const polygon = kind === "polygon" && sides !== null;
  const oval = kind === "oval" && f.pieStart.bindingState === "value";
  const rect = kind === "rectangle" && f.optTopLeft.bindingState === "value";
  if (!one || (!polygon && !oval && !rect)) return null;

  const batch = (ops: Mutation[]) => {
    if (ops.length === 0) return;
    void client.mutate(
      ops.length === 1 ? ops[0]! : ({ op: "batch", args: { ops } } as Mutation),
    );
  };
  const length = (value: number | null): Value =>
    ({ type: "length", value }) as Value;

  const corner = (suffix: CornerSuffix) => {
    const opt = f[`opt${suffix}`];
    const rad = f[`rad${suffix}`];
    const option = text(opt.value) || "None";
    const radius = num(rad.value) ?? DEFAULT_RADIUS;
    return { suffix, opt, rad, option, radius };
  };
  const corners = CORNERS.map((c) => corner(c.suffix));
  // A radius typed on a square corner rounds it (Illustrator's widget
  // and field both do): the option and the radius are one write.
  const commitRadius = (suffix: CornerSuffix, r: number) => {
    const targets = linked
      ? corners
      : corners.filter((c) => c.suffix === suffix);
    const ops: Mutation[] = [];
    for (const c of targets) {
      ops.push(
        set(one, `frameCornerRadius${c.suffix}`, length(Math.max(0, r))),
      );
      if (c.option === "None" && r > 0) {
        ops.push(
          set(one, `frameCornerOption${c.suffix}`, {
            type: "text",
            value: "RoundedCorner",
          } as Value),
        );
      }
    }
    batch(ops);
  };
  const commitOption = (suffix: CornerSuffix, option: string) => {
    const targets = linked
      ? corners
      : corners.filter((c) => c.suffix === suffix);
    batch(
      targets.map((c) =>
        set(one, `frameCornerOption${c.suffix}`, {
          type: "text",
          value: option,
        } as Value),
      ),
    );
  };

  return (
    <div
      className="-mx-3 border-t border-input px-3"
      data-section="Shape"
      data-shape-kind={kind}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent py-[9px] text-left"
        data-section-toggle
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className="whitespace-nowrap text-[12.5px] font-semibold"
          style={{ color: "var(--pg-fg)" }}
        >
          {strings.t(M.shape)}
        </span>
        <Icon
          name={open ? "ui-chevron-down" : "ui-chevron-right"}
          size={14}
          style={{ color: "var(--pg-muted-fg)" }}
        />
      </button>
      {open && polygon && (
        <div className="grid grid-cols-2 gap-2 pb-3" data-shape-polygon>
          <ObjectFieldFrame field={f.sides}>
            <NumberInput
              prefix={strings.t(inset ? M.points : M.sides)}
              value={sides}
              min={MIN_SIDES}
              max={MAX_SIDES}
              precision={0}
              step={0.1}
              disabled={f.sides.onCommit == null}
              onChange={() => {}}
              onCommit={(next) => f.sides.onCommit?.(length(Math.round(next)))}
              aria-label={strings.t(inset ? M.points : M.sides)}
            />
          </ObjectFieldFrame>
          <ObjectFieldFrame field={f.inset}>
            <NumberInput
              icon="tool-polygon"
              suffix="%"
              value={inset}
              min={0}
              max={MAX_STAR_INSET}
              precision={0}
              disabled={f.inset.onCommit == null}
              onChange={() => {}}
              onCommit={(next) => f.inset.onCommit?.(length(next))}
              aria-label={strings.t(M.starInset)}
            />
          </ObjectFieldFrame>
        </div>
      )}
      {open && oval && (
        <div className="flex flex-col gap-2 pb-3" data-shape-pie>
          <div className="grid grid-cols-2 gap-2">
            <ObjectFieldFrame field={f.pieStart}>
              <NumberInput
                prefix={strings.t(M.pieStart)}
                suffix="°"
                value={num(f.pieStart.value)}
                min={0}
                max={360}
                precision={1}
                disabled={f.pieStart.onCommit == null}
                onChange={() => {}}
                onCommit={(next) => f.pieStart.onCommit?.(length(next))}
                aria-label={strings.t(M.pieStart)}
              />
            </ObjectFieldFrame>
            <ObjectFieldFrame field={f.pieEnd}>
              <NumberInput
                prefix={strings.t(M.pieEnd)}
                suffix="°"
                value={num(f.pieEnd.value)}
                min={0}
                max={360}
                precision={1}
                disabled={f.pieEnd.onCommit == null}
                onChange={() => {}}
                onCommit={(next) => f.pieEnd.onCommit?.(length(next))}
                aria-label={strings.t(M.pieEnd)}
              />
            </ObjectFieldFrame>
          </div>
          <button
            type="button"
            data-invert-pie
            disabled={f.pieStart.onCommit == null}
            className="h-[28px] rounded-[6px] border-0 text-xs font-semibold"
            style={{ background: "var(--pg-muted)", color: "var(--pg-fg)" }}
            onClick={() => {
              const s = num(f.pieStart.value) ?? 0;
              const e = num(f.pieEnd.value) ?? 360;
              // The other wedge: the end becomes the start. Two writes,
              // one step; half-way the two angles meet, which the engine
              // keeps (it draws the ellipse there and loses neither).
              batch([
                set(one, "frameShapePieStart", length(e % 360)),
                set(one, "frameShapePieEnd", length(s === 0 ? 360 : s)),
              ]);
            }}
          >
            {strings.t(M.invertPie)}
          </button>
        </div>
      )}
      {open && rect && (
        <div className="flex flex-col gap-2 pb-3" data-shape-corners>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
              {strings.t(M.corners)}
            </span>
            <button
              type="button"
              data-link-corners={linked ? "true" : "false"}
              aria-pressed={linked}
              title={strings.t(linked ? M.unlinkCorners : M.linkCorners)}
              className="h-[24px] w-[24px] rounded-[6px] border border-input"
              style={{
                background: linked ? "var(--pg-primary)" : "var(--pg-muted)",
                color: linked ? "var(--pg-primary-fg)" : "var(--pg-fg)",
              }}
              onClick={() => setLinked(!linked)}
            >
              <Icon name="ui-component" size={12} className="mx-auto" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {corners.map((c) => {
              const name = strings.t(CORNER_NAMES[c.suffix]);
              return (
                <div
                  key={c.suffix}
                  className="flex flex-col gap-1"
                  data-corner={c.suffix}
                >
                  <KitSelect
                    value={c.option}
                    aria-label={name}
                    disabled={c.opt.onCommit == null}
                    onChange={(e) => commitOption(c.suffix, e.target.value)}
                  >
                    {OPTIONS.map(([token, label]) => (
                      <option key={token} value={token}>
                        {strings.t(label)}
                      </option>
                    ))}
                  </KitSelect>
                  <LengthInput
                    valuePt={c.option === "None" ? 0 : c.radius}
                    min={0}
                    disabled={c.rad.onCommit == null}
                    onChangePt={() => {}}
                    onCommitPt={(r) => commitRadius(c.suffix, r)}
                    aria-label={strings.t(M.radius, { corner: name })}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
