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

// `paged.input.pageBounds` — the Object section's geometry row (Properties
// and the Control panel), reading where the selection IS rather than its
// inner `frameBounds` (see `page-position.ts`).
//
// UX audit F-38 / PN-252: it reads as the Transform panel does, X / Y / W
// / H with a reference point, not Top / Left / Bottom / Right. X / Y move
// the selection (rigidly, one undo step, any selection); W / H resize
// about the reference point and are editable where an edge write is the
// edge the user sees (one rectangle, ellipse or text frame with no
// rotation, scale or shear), read-only otherwise: a rotated frame, a line,
// a path, a group, a multi-selection, where a `frameBounds` write would
// land somewhere other than the number typed.

import { useState } from "react";
import type { CatalogEntry, LeafProps } from "@paged-media/catalog";
import { ReferencePointGrid } from "@paged-media/shell";
import { LengthInput } from "@paged-media/ui";

import { usePagePosition } from "./page-position";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.pageBoundsLeaf", {
  x: "X",
  y: "Y",
  w: "W",
  h: "H",
  xLabel: "x",
  yLabel: "y",
  widthLabel: "width",
  heightLabel: "height",
});

export const PAGED_INPUT_PAGE_BOUNDS = "paged.input.pageBounds";

/** The 9-point anchor (row-major, 0 = top-left) as fractions of the box. */
function anchorFractions(index: number): { fx: number; fy: number } {
  return { fx: (index % 3) / 2, fy: Math.floor(index / 3) / 2 };
}

function PageBoundsLeaf({ props }: LeafProps) {
  const strings = useStrings();
  const { box, edgeLeaf, moveBy, setEdges } = usePagePosition();
  const [anchor, setAnchor] = useState(0);
  const label = typeof props?.label === "string" ? props.label : null;
  const x = box ? box.left : null;
  const y = box ? box.top : null;
  const w = box ? box.right - box.left : null;
  const h = box ? box.bottom - box.top : null;
  const resize = (nw: number, nh: number) => {
    if (!box || w === null || h === null) return;
    const { fx, fy } = anchorFractions(anchor);
    const left = box.left + fx * w - fx * nw;
    const top = box.top + fy * h - fy * nh;
    void setEdges({ top, left, bottom: top + nh, right: left + nw });
  };
  return (
    <div
      className="flex flex-col gap-[6px]"
      data-page-bounds={edgeLeaf ? "edges" : "readout"}
      data-reference-point-anchor={anchor}
    >
      {label ? (
        <div className="text-[11.5px]" style={{ color: "var(--pg-muted-fg)" }}>
          {label}
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        <ReferencePointGrid
          value={anchor}
          disabled={!edgeLeaf}
          onChange={(i) => setAnchor(i)}
        />
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
          <LengthInput
            prefix={strings.t(M.x)}
            valuePt={x}
            disabled={!box}
            onChangePt={() => {}}
            onCommitPt={(nx) => {
              if (x !== null) void moveBy(nx - x, 0);
            }}
            aria-label={strings.t(M.xLabel)}
          />
          <LengthInput
            prefix={strings.t(M.y)}
            valuePt={y}
            disabled={!box}
            onChangePt={() => {}}
            onCommitPt={(ny) => {
              if (y !== null) void moveBy(0, ny - y);
            }}
            aria-label={strings.t(M.yLabel)}
          />
          <LengthInput
            prefix={strings.t(M.w)}
            valuePt={w}
            min={0}
            disabled={!edgeLeaf}
            onChangePt={() => {}}
            onCommitPt={(nw) => {
              if (h !== null) resize(nw, h);
            }}
            aria-label={strings.t(M.widthLabel)}
          />
          <LengthInput
            prefix={strings.t(M.h)}
            valuePt={h}
            min={0}
            disabled={!edgeLeaf}
            onChangePt={() => {}}
            onCommitPt={(nh) => {
              if (w !== null) resize(w, nh);
            }}
            aria-label={strings.t(M.heightLabel)}
          />
        </div>
      </div>
    </div>
  );
}

/** The catalog entry. */
export function pageBoundsEntry(): CatalogEntry {
  return {
    id: PAGED_INPUT_PAGE_BOUNDS,
    kind: "leaf",
    props: {
      label: "string",
      labels: "JsonValue",
      layout: "string",
      seam: "boolean",
    },
    bindings: {
      reads: [
        "selection",
        "selectionProperty:frameBounds",
        "selectionProperty:frameTransform",
      ],
      writes: ["geometry", "selectionProperty:frameBounds"],
    },
    leaf: PageBoundsLeaf,
  };
}
