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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADR 291 — View ▸ Show data markers: which frames the document's
// data is placed in, and whether each is in step with the data.
//
// WHAT IT DRAWS. Thin corner brackets on every page item a binding places
// content in (`data@1` `placements()`), stroked in the binding's sync
// state, the colours the Data panel's headers use: in step (linked) the
// approved green, changed in the data or kept as placed (stale, pinned,
// overridden, not resolved yet) the review amber, failed the error red. A
// frame several bindings place into takes the worst of them. Brackets, not
// a box, so a marker never reads as the selection's outline.
//
// COST. Off by default, and nothing is read while it is off. On, one
// `placements()` of the service and one batched `elementGeometry`, again
// when the data changes (`useDataRevision`) and on the pushes that move a
// frame.

import { useEffect, useState, useSyncExternalStore } from "react";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";
import type { DataPlacement, DataService } from "@paged-media/plugin-api";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useCanvasClient } from "../state/canvas-client-context";
import { useDataRevision, useDataService } from "../state/data-door";
import { useEditorScope } from "../state/editor-scope";
import { getViewToggle, subscribeViewToggles } from "../state/view-toggles";

import { applyAffine } from "./affine";

const PAGE_ITEM =
  /^(textFrame|rectangle|oval|polygon|graphicLine|group):([^\s,>]+)$/;

/** The page item an ADR 131 address names (`rectangle:u12`), or null for
 *  anything else (a story range, a style, a selector). */
export function elementOfPlacement(address: string): ElementId | null {
  const m = PAGE_ITEM.exec(address);
  return m ? ({ kind: m[1], id: m[2] } as ElementId) : null;
}

export type DataMarkerTone = "ok" | "warn" | "error";

const RANK: Record<DataMarkerTone, number> = { ok: 1, warn: 2, error: 3 };

function toneOf(status: DataPlacement["status"]): DataMarkerTone {
  if (status === "linked") return "ok";
  if (status === "error") return "error";
  return "warn";
}

/** The stroke token of each tone (globals.css re-applies each). */
const STROKE: Record<DataMarkerTone, string> = {
  ok: "var(--status-approved)",
  warn: "var(--status-review)",
  error: "var(--status-error)",
};

/** Per placed page item: its element and the worst state placing into it. */
export function markersOf(
  placements: readonly DataPlacement[],
): Map<string, { element: ElementId; tone: DataMarkerTone }> {
  const out = new Map<string, { element: ElementId; tone: DataMarkerTone }>();
  for (const p of placements) {
    const element = elementOfPlacement(p.address);
    if (!element) continue;
    const tone = toneOf(p.status);
    const cur = out.get(p.address);
    if (!cur || RANK[tone] > RANK[cur.tone])
      out.set(p.address, { element, tone });
  }
  return out;
}

interface Marker {
  address: string;
  tone: DataMarkerTone;
  geometry: ElementGeometryItem;
}

/** The markers to draw, read through the service and the client;
 *  "superseded" when a newer read started meanwhile, none when a read
 *  fails. Outside the component: the React Compiler does not compile a
 *  conditional inside a `try` (ADR 229). */
async function readMarkers(
  service: DataService,
  client: ReturnType<typeof useCanvasClient>,
  current: () => boolean,
): Promise<Marker[] | "superseded"> {
  try {
    if (typeof service.placements !== "function") return [];
    const placed = markersOf(await service.placements());
    if (!current()) return "superseded";
    if (placed.size === 0) return [];
    const items = await client.elementGeometry(
      [...placed.values()].map((m) => m.element),
    );
    if (!current()) return "superseded";
    const out: Marker[] = [];
    for (const item of items) {
      const address = `${item.id.kind}:${String(item.id.id)}`;
      const m = placed.get(address);
      if (m) out.push({ address, tone: m.tone, geometry: item });
    }
    return out;
  } catch {
    return current() ? [] : "superseded";
  }
}

function DataMarkersRender(props: OverlayProps) {
  const client = useCanvasClient();
  const scope = useEditorScope();
  const service = useDataService();
  const revision = useDataRevision();
  const on = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "dataMarkers"),
    () => false,
  );
  const [markers, setMarkers] = useState<Marker[]>([]);

  useEffect(() => {
    if (!on || !service) return;
    // Each refresh is numbered: a late reply of an older one (every await
    // is a chance for the document to have moved on) is dropped.
    const runs = { latest: 0, live: true };
    const refresh = () => {
      runs.latest += 1;
      const mine = runs.latest;
      void readMarkers(
        service,
        client,
        () => runs.live && mine === runs.latest,
      ).then((read) => {
        if (read !== "superseded") setMarkers(read);
      });
    };
    refresh();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "documentLoaded"
      )
        refresh();
    });
    return () => {
      off();
      runs.live = false;
      // Toggled off (or the service gone): drop the mirror, so turning the
      // markers on again never flashes the state of edits ago.
      setMarkers([]);
    };
  }, [on, service, client, revision]);

  if (!on || !service) return <g data-data-markers="off" />;

  const inv = 1 / props.camera.scale;
  const drawn: { key: string; tone: DataMarkerTone; d: string }[] = [];
  for (const m of markers) {
    const g = m.geometry;
    const pr = g.pageId ? props.pageRects.get(g.pageId) : undefined;
    if (!pr) continue;
    const [top, left, bottom, right] = g.bounds;
    const at = (x: number, y: number): [number, number] => {
      const [px, py] = applyAffine(g.itemTransform, x, y);
      return [pr.x + px, pr.y + py];
    };
    // Each corner's two arms run a third of its edge, at most 10 screen px.
    const arm = (len: number) => Math.min(10 * inv, Math.abs(len) / 3);
    const ax = arm(right - left);
    const ay = arm(bottom - top);
    const sx = right >= left ? 1 : -1;
    const sy = bottom >= top ? 1 : -1;
    const corners: [number, number, number, number][] = [
      [left, top, sx, sy],
      [right, top, -sx, sy],
      [right, bottom, -sx, -sy],
      [left, bottom, sx, -sy],
    ];
    let d = "";
    for (const [x, y, dx, dy] of corners) {
      const a = at(x + dx * ax, y);
      const c = at(x, y);
      const b = at(x, y + dy * ay);
      d += `M${a[0]} ${a[1]}L${c[0]} ${c[1]}L${b[0]} ${b[1]}`;
    }
    drawn.push({ key: m.address, tone: m.tone, d });
  }

  return (
    <g data-data-markers={drawn.length > 0 ? "ready" : "empty"}>
      {drawn.map((m) => (
        <path
          key={m.key}
          data-data-marker={m.key}
          data-tone={m.tone}
          d={m.d}
          stroke={STROKE[m.tone]}
          strokeWidth={1.5 * inv}
          strokeLinecap="square"
          fill="none"
        />
      ))}
    </g>
  );
}

export const dataMarkersContribution: OverlayContribution = {
  id: "paged.overlay.dataMarkers",
  render: DataMarkersRender,
  // Under the selection chrome (z 100 default), beside the thread lines.
  z: 55,
};
