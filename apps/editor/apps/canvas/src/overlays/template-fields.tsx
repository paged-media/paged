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
// Template field outlines on the canvas (docs/composable-editor.md §7.9,
// §7.10; plan task D3): for an author and a filler, every field's frame is
// outlined with its label, so the open parts of a template are visible at a
// glance, and a picture field carries a Replace button. An editor and a
// viewer see the document as it prints.
//
// The outline is drawn in document space inside the overlay host's camera
// group; the label and the button are scaled by 1 / zoom so they keep their
// size on screen. The button is the one interactive part of the overlay.

import { useEffect, useState, type ReactElement } from "react";

import type {
  ElementGeometryItem,
  TemplateFieldSummary,
} from "@paged-media/client";
import {
  applyAffine,
  chooseFiles,
  useCanvasClient,
  useCollection,
  useSessionRole,
  type OverlayContribution,
  type OverlayProps,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.overlaysTemplateFields", {
  replaceLabel: "Replace {label}",
  replace: "Replace…",
});

const IMAGE_TYPES = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".tif",
  ".tiff",
  ".psd",
  ".webp",
];

function TemplateFieldsRender(props: OverlayProps): ReactElement | null {
  const role = useSessionRole();
  const strings = useStrings();
  const client = useCanvasClient();
  const rows = useCollection<TemplateFieldSummary>("templateFields");
  const [geometry, setGeometry] = useState<readonly ElementGeometryItem[]>([]);
  const shown = role === "author" || role === "filler";
  const ids = (rows ?? []).flatMap((r) => (r.elementId ? [r.elementId] : []));
  const idsKey = JSON.stringify(ids);

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    const wanted = JSON.parse(idsKey) as typeof ids;
    // No fields: the render returns before it reads any geometry.
    if (wanted.length === 0) return;
    // Refetched whenever the field list is, which `useCollection` does
    // after every change to the document.
    void client.elementGeometry(wanted).then((items) => {
      if (!cancelled) setGeometry(items);
    });
    return () => {
      cancelled = true;
    };
  }, [client, idsKey, shown, rows]);

  if (!shown || !rows || rows.length === 0) return null;
  const k = 1 / Math.max(props.camera.scale, 1e-6);

  const replace = async (elementId: string) => {
    const [file] = await chooseFiles({ accept: IMAGE_TYPES });
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await client.mutateWithBytes(
      { op: "replaceImageBytes", args: { elementId, bytes: [] } },
      bytes,
      true,
    );
  };

  const out: ReactElement[] = [];
  for (const row of rows) {
    // Matched by kind and id: the two replies spell the id's keys in a
    // different order, so the objects do not compare as strings.
    const g = geometry.find(
      (item) =>
        row.elementId !== null &&
        row.elementId !== undefined &&
        item.id.kind === row.elementId.kind &&
        JSON.stringify(item.id.id) === JSON.stringify(row.elementId.id),
    );
    const pr = g?.pageId ? props.pageRects.get(g.pageId) : undefined;
    if (!g || !pr) continue;
    const [top, left, bottom, right] = g.bounds;
    const corners = (
      [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ] as const
    ).map(([x, y]) => applyAffine(g.itemTransform, x, y));
    const points = corners.map(([x, y]) => `${pr.x + x},${pr.y + y}`).join(" ");
    const [lx, ly] = corners[0]!;
    const label = row.field.label ?? row.field.name;
    out.push(
      <g key={row.field.name} data-template-field-outline={row.field.name}>
        <polygon
          points={points}
          fill="none"
          style={{ stroke: "var(--pg-primary)" }}
          strokeWidth={1.25}
          strokeDasharray="5 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        <g transform={`translate(${pr.x + lx} ${pr.y + ly}) scale(${k})`}>
          <text
            x={2}
            y={-4}
            style={{
              fill: "var(--pg-primary)",
              fontFamily: "var(--font-sans)",
            }}
            fontSize={10.5}
            pointerEvents="none"
          >
            {label}
            {row.field.required ? " *" : ""}
          </text>
          {row.field.kind === "image" ? (
            <g
              data-template-field-replace={row.field.name}
              role="button"
              aria-label={strings.t(M.replaceLabel, { label })}
              tabIndex={0}
              pointerEvents="all"
              style={{ cursor: "pointer" }}
              transform="translate(4 4)"
              onClick={() => void replace(row.targetId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  void replace(row.targetId);
              }}
            >
              <rect
                width={64}
                height={20}
                rx={4}
                style={{ fill: "var(--pg-primary)" }}
              />
              <text
                x={32}
                y={14}
                textAnchor="middle"
                fontSize={11}
                style={{
                  fill: "var(--pg-primary-fg, #fff)",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {strings.t(M.replace)}
              </text>
            </g>
          ) : null}
        </g>
      </g>,
    );
  }
  return <>{out}</>;
}

/** Outlines, labels and Replace buttons for a template's fields. */
export const templateFieldsContribution: OverlayContribution = {
  id: "paged.template-fields",
  render: TemplateFieldsRender,
  z: 190,
};
