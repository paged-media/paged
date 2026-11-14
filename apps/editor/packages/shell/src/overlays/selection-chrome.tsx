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
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ElementGeometryItem } from "@paged-media/client";

import { useOptionalCanvasClient } from "../state/canvas-client-context";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useSelection } from "../state/selection-context";
import {
  ALIGN_SCOPE,
  effectiveKeyObject,
  isSameElement,
} from "../state/align-scope";
import { useScoped } from "../state/editor-scope";
import { useLockedKeys } from "../state/locked";

import { applyAffine } from "./affine";

/**
 * Outlines + per-element bounding chrome for selected elements.
 *
 * - Single selection: oriented bbox via the element's
 *   `itemTransform` applied to its `bounds` corners.
 * - Multi-selection: per-element bboxes plus a dashed union AABB
 *   (per page).
 *
 * Read directly from the selection context — no props beyond the
 * registry's standard `OverlayProps`.
 */
function SelectionChromeRender(props: OverlayProps) {
  // Placed: a pasteboard item is drawn against the nearest page of its
  // spread, in that page's space (see `spread-pages`).
  const { placedGeometry: elementGeometry, elementSelection } = useSelection();
  // WP4.4 — Align to key object: the key is drawn with a thicker outline.
  const alignStore = useScoped(ALIGN_SCOPE);
  const alignScope = useSyncExternalStore(
    alignStore.subscribe,
    alignStore.get,
    alignStore.get,
  );
  const keyObject = effectiveKeyObject(alignScope, elementSelection);
  // D-07 / UXI-SEL-018 — while an align control is hovered or focused the
  // canvas shows what it aligns against: the key object, the selection's
  // box, the page, its margins or the spread.
  const previewing = alignScope.previewing === true;
  const pages = useAlignPages(
    previewing && (alignScope.to === "margins" || alignScope.to === "spread"),
  );
  // D-08 / `UXI-OVR-008`: a locked item stays selectable and says it is
  // locked by its shape — a dashed outline and a padlock at its corner —
  // never by colour alone.
  const locked = useLockedKeys(elementSelection);
  if (elementGeometry.length === 0) return null;
  const inv = 1 / (props.camera.scale > 0 ? props.camera.scale : 1);

  const out: ReactNode[] = [];
  for (const g of elementGeometry) {
    const pr = g.pageId ? props.pageRects.get(g.pageId) : undefined;
    if (!pr) continue; // C-23 — no page found for it ⇒ no chrome
    const [top, left, bottom, right] = g.bounds;
    const corners: Array<[number, number]> = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
    const points = corners
      .map(([x, y]) => applyAffine(g.itemTransform, x, y))
      .map(([x, y]) => `${pr.x + x},${pr.y + y}`)
      .join(" ");
    const key = `${g.id.kind}:${g.id.id}`;
    const isKey = keyObject !== null && isSameElement(g.id, keyObject);
    const isLocked = locked.has(key);
    out.push(
      <polygon
        key={key}
        points={points}
        fill={isKey && previewing ? "var(--overlay-selection)" : "none"}
        stroke="var(--overlay-selection)"
        strokeWidth={isKey ? 4 : 2}
        strokeDasharray={isLocked ? "6 3" : undefined}
        data-key-object={isKey ? "" : undefined}
        data-align-reference={
          isKey && previewing && alignScope.to === "keyObject"
            ? "keyObject"
            : undefined
        }
        fillOpacity={isKey && previewing ? 0.12 : undefined}
        data-selection-outline=""
        data-selection-locked={isLocked ? key : undefined}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />,
    );
    if (isLocked) {
      const [lx, ly] = applyAffine(g.itemTransform, left, top);
      out.push(
        <LockGlyph key={`${key}:lock`} x={pr.x + lx} y={pr.y + ly} inv={inv} />,
      );
    }
  }

  // Multi-select union AABB, per page.
  if (elementGeometry.length > 1) {
    out.push(
      ...renderUnionBoxes(
        elementGeometry,
        props,
        previewing && alignScope.to === "selection",
      ),
    );
  }
  if (previewing)
    out.push(
      ...renderPageReference(alignScope.to, elementGeometry, props, pages),
    );

  return <>{out}</>;
}

/** A page's margins and spread, as the pages collection reports them. */
interface AlignPageRow {
  selfId: string;
  spreadId?: string | null;
  marginTopPt?: number;
  marginLeftPt?: number;
  marginBottomPt?: number;
  marginRightPt?: number;
}

/** The pages' margins and spreads, read while a margins or spread
 *  reference is previewed. */
function useAlignPages(enabled: boolean): readonly AlignPageRow[] {
  const client = useOptionalCanvasClient();
  const [rows, setRows] = useState<readonly AlignPageRow[]>([]);
  useEffect(() => {
    if (!enabled || !client) return;
    let live = true;
    client
      .collection<AlignPageRow>("pages")
      .then((next) => {
        if (live) setRows(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, client]);
  return rows;
}

/** The page, margins or spread an alignment would use, outlined. */
function renderPageReference(
  to: string,
  geometry: ReadonlyArray<ElementGeometryItem>,
  props: OverlayProps,
  pages: readonly AlignPageRow[],
): ReactNode[] {
  if (to !== "page" && to !== "margins" && to !== "spread") return [];
  const pageIds = [...groupByPage(geometry).keys()];
  const rects: Array<{
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
  const seen = new Set<string>();
  for (const pageId of pageIds) {
    const pr = props.pageRects.get(pageId);
    if (!pr) continue;
    const row = pages.find((p) => p.selfId === pageId);
    if (to === "page") {
      rects.push({ key: pageId, ...pr });
    } else if (to === "margins") {
      const t = row?.marginTopPt ?? 0;
      const l = row?.marginLeftPt ?? 0;
      const b = row?.marginBottomPt ?? 0;
      const r = row?.marginRightPt ?? 0;
      rects.push({
        key: pageId,
        x: pr.x + l,
        y: pr.y + t,
        w: Math.max(0, pr.w - l - r),
        h: Math.max(0, pr.h - t - b),
      });
    } else {
      const spread = row?.spreadId ?? pageId;
      if (seen.has(spread)) continue;
      seen.add(spread);
      const members = pages.filter((p) => (p.spreadId ?? p.selfId) === spread);
      const boxes = (
        members.length > 0 ? members.map((m) => m.selfId) : [pageId]
      )
        .map((id) => props.pageRects.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      if (boxes.length === 0) continue;
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const x2 = Math.max(...boxes.map((b) => b.x + b.w));
      const y2 = Math.max(...boxes.map((b) => b.y + b.h));
      rects.push({ key: spread, x, y, w: x2 - x, h: y2 - y });
    }
  }
  return rects.map((r) => (
    <rect
      key={`align-ref:${r.key}`}
      x={r.x}
      y={r.y}
      width={r.w}
      height={r.h}
      fill="none"
      stroke="var(--overlay-selection)"
      strokeWidth={2}
      strokeDasharray="6 4"
      data-align-reference={to}
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  ));
}

/** A padlock, 12 CSS px, just above an item's top-left corner. */
function LockGlyph(props: { x: number; y: number; inv: number }) {
  return (
    <g
      transform={`translate(${props.x}, ${props.y}) scale(${props.inv}) translate(0, -16)`}
      data-lock-glyph=""
      pointerEvents="none"
    >
      <rect
        x={0}
        y={5}
        width={12}
        height={9}
        rx={1.5}
        fill="var(--overlay-selection)"
      />
      <path
        d="M3 5 V3.5 a3 3 0 0 1 6 0 V5"
        fill="none"
        stroke="var(--overlay-selection)"
        strokeWidth={1.6}
      />
    </g>
  );
}

function renderUnionBoxes(
  geometry: ReadonlyArray<ElementGeometryItem>,
  props: OverlayProps,
  reference = false,
): ReactNode[] {
  const byPage = groupByPage(geometry);
  const out: ReactNode[] = [];
  for (const [pageId, items] of byPage) {
    const pr = props.pageRects.get(pageId);
    if (!pr) continue;
    const bb = unionAabb(items);
    if (!bb) continue;
    out.push(
      <rect
        key={`union:${pageId}`}
        x={pr.x + bb.minX}
        y={pr.y + bb.minY}
        width={bb.maxX - bb.minX}
        height={bb.maxY - bb.minY}
        fill="none"
        stroke="var(--overlay-selection)"
        strokeWidth={reference ? 2 : 1}
        strokeDasharray="4 3"
        data-align-reference={reference ? "selection" : undefined}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />,
    );
  }
  return out;
}

export function groupByPage(
  geometry: ReadonlyArray<ElementGeometryItem>,
): Map<string, ElementGeometryItem[]> {
  const byPage = new Map<string, ElementGeometryItem[]>();
  for (const g of geometry) {
    // C-23 — `pageId` is null for a PASTEBOARD element. The selection
    // overlays group `placedGeometry`, where such an element already sits
    // on a page; one that is still pageless has no space to be drawn in,
    // so it is not grouped and gets no chrome.
    if (!g.pageId) continue;
    const list = byPage.get(g.pageId) ?? [];
    list.push(g);
    byPage.set(g.pageId, list);
  }
  return byPage;
}

export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function unionAabb(
  items: ReadonlyArray<ElementGeometryItem>,
): Aabb | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const g of items) {
    const [top, left, bottom, right] = g.bounds;
    const corners: Array<[number, number]> = [
      applyAffine(g.itemTransform, left, top),
      applyAffine(g.itemTransform, right, top),
      applyAffine(g.itemTransform, right, bottom),
      applyAffine(g.itemTransform, left, bottom),
    ];
    for (const [x, y] of corners) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY };
}

export const selectionChromeContribution: OverlayContribution = {
  id: "paged.selection-chrome",
  render: SelectionChromeRender,
  z: 200,
};
