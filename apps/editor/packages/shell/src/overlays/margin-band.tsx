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

// Editor ADR 300 — the markup margin band (extensions ADR 349 amendment 1,
// C5): a column beside each page holding a bundle's balloons (Word's
// tracked-change balloons and comment threads), each level with the first
// line of the text it is anchored to. The host owns the geometry: anchors
// are read from the engine's selection geometry (the rects the selection
// highlight uses), balloons that would overlap are pushed down in text
// order, and a leader line runs from the anchor to its balloon. Everything
// is re-read when the bundle says its items changed and on every push that
// moves text (a mutation, undo, redo, a new document). Screen-constant
// size: the balloons scale by the camera's inverse, as the sub-context bar
// does. Overlay chrome: never printed or exported.

import { useEffect, useRef, useState } from "react";

import type {
  CaretGeometry,
  ContentSelection,
  SelectionRect,
} from "@paged-media/client";
import type * as Api from "@paged-media/plugin-api";

import { activeScopeContext } from "../registries/context-bar";
import type { MarginBandContribution } from "../registries/context-bar";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useContentSelection } from "../state/content-selection-context";
import { useRegistryView } from "../state/live";
import { useOptionalPaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";

/** Default balloon width, screen px. */
export const BALLOON_WIDTH_PX = 240;
/** A balloon's height before it is measured, screen px. */
export const BALLOON_HEIGHT_PX = 48;
/** The gap between the page and the band, and between balloons, px. */
export const BALLOON_GAP_PX = 8;

/** Where an anchor stands: the page and the first line's box, page-local
 *  points. */
export interface AnchorBox {
  pageId: string;
  leftPt: number;
  topPt: number;
  widthPt: number;
  heightPt: number;
}

/** One balloon to lay out. */
export interface BalloonInput {
  key: string;
  anchor: AnchorBox;
  /** The balloon's height in document points. */
  heightPt: number;
}

/**
 * The top of each balloon, in page-local points, per page: level with its
 * anchor's line, pushed below the one before it (in text order: page, then
 * top, then left) with `gapPt` between them. Pure, for the tests.
 */
export function layoutBalloons(
  balloons: readonly BalloonInput[],
  gapPt: number,
): Map<string, number> {
  const byPage = new Map<string, BalloonInput[]>();
  for (const b of balloons) {
    const list = byPage.get(b.anchor.pageId) ?? [];
    list.push(b);
    byPage.set(b.anchor.pageId, list);
  }
  const out = new Map<string, number>();
  for (const list of byPage.values()) {
    list.sort(
      (a, b) =>
        a.anchor.topPt - b.anchor.topPt ||
        a.anchor.leftPt - b.anchor.leftPt ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    let floor = -Infinity;
    for (const b of list) {
      const top = Math.max(b.anchor.topPt, floor);
      out.set(b.key, top);
      floor = top + b.heightPt + gapPt;
    }
  }
  return out;
}

/** Does the selection touch the item's anchor? */
export function anchorTouched(
  sel: ContentSelection | null,
  anchor: Api.MarginBandAnchor,
): boolean {
  if (!sel || sel.cell || sel.storyId !== anchor.storyId) return false;
  const [s, e] =
    sel.start <= sel.end ? [sel.start, sel.end] : [sel.end, sel.start];
  return s <= anchor.end && e >= anchor.start;
}

type Client = NonNullable<ReturnType<typeof useOptionalCanvasClient>>;

interface BandItem {
  key: string;
  band: MarginBandContribution;
  item: Api.MarginBandItem;
}

/** The first line box of each item's anchor (none for an anchor that is
 *  not laid out); "superseded" when a newer read started. Outside the
 *  component: the React Compiler does not compile a conditional inside a
 *  `try` (ADR 229). */
async function readAnchors(
  client: Client,
  items: readonly BandItem[],
  current: () => boolean,
): Promise<Map<string, AnchorBox> | "superseded"> {
  const out = new Map<string, AnchorBox>();
  for (const it of items) {
    const { storyId, start, end } = it.item.anchor;
    const sel: ContentSelection = { storyId, start, end, affinity: false };
    try {
      let box: AnchorBox | null = null;
      if (end > start) {
        const rects: SelectionRect[] = await client.selectionGeometry(sel);
        const r = rects[0];
        if (r) box = { ...r, pageId: String(r.pageId) };
      }
      if (!box) {
        const c: CaretGeometry | null = await client.caretGeometry({
          ...sel,
          end: start,
        });
        if (c)
          box = {
            pageId: String(c.pageId),
            leftPt: c.xPt,
            topPt: c.topPt,
            widthPt: 0,
            heightPt: c.heightPt,
          };
      }
      if (box) out.set(it.key, box);
    } catch {
      // An anchor the engine cannot place (a deleted story) has no balloon.
    }
    if (!current()) return "superseded";
  }
  return out;
}

/** The items of every band, keyed `<band>/<item>`. */
function collectItems(bands: readonly MarginBandContribution[]): BandItem[] {
  const out: BandItem[] = [];
  for (const band of bands) {
    let items: readonly Api.MarginBandItem[] = [];
    try {
      items = band.items();
    } catch {
      items = [];
    }
    for (const item of items)
      out.push({ key: `${band.id}/${item.id}`, band, item });
  }
  return out;
}

/** One balloon's body: the bundle's component, measured so the layout
 *  knows its height. */
function Balloon(props: {
  entry: BandItem;
  editContext: string;
  active: boolean;
  widthPx: number;
  onHeight: (key: string, px: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { entry, onHeight } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(entry.key, el.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry.key, onHeight]);
  const Render = entry.band.render;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      ref={ref}
      role="note"
      aria-label={entry.item.kind ?? entry.band.title ?? entry.band.id}
      data-margin-balloon={entry.item.id}
      data-margin-kind={entry.item.kind}
      data-active={props.active ? "true" : undefined}
      onPointerDown={stop}
      onPointerUp={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      style={{
        width: props.widthPx,
        boxSizing: "border-box",
        fontSize: 12,
        color: "var(--pg-fg)",
        background: "var(--pg-bg)",
        border: `1px solid ${entry.item.color ?? "var(--chrome-border)"}`,
        borderLeftWidth: 3,
        borderRadius: 4,
        padding: "4px 6px",
        boxShadow: props.active ? "0 1px 4px rgba(0,0,0,0.25)" : undefined,
      }}
    >
      <Render
        item={entry.item}
        editContext={props.editContext}
        active={props.active}
      />
    </div>
  );
}

function MarginBandRender(props: OverlayProps) {
  const editContext = activeScopeContext(useOptionalPaged());
  return <MarginBandView {...props} editContext={editContext} />;
}

/** The band for `editContext` (the active scope context in the editor; a
 *  test passes one). */
export function MarginBandView(
  props: OverlayProps & { editContext: string | null },
) {
  const { editContext } = props;
  const registries = useRegistries();
  const registry = useRegistryView(registries.marginBands);
  const bands = registry.forContext(editContext);
  const client = useOptionalCanvasClient();
  const { contentSelection } = useContentSelection();
  const [items, setItems] = useState<BandItem[]>([]);
  const [anchors, setAnchors] = useState<Map<string, AnchorBox>>(new Map());
  const [heights, setHeights] = useState<Map<string, number>>(new Map());

  // The bands' items, read again whenever a band says they changed.
  useEffect(() => {
    const shown = registry.forContext(editContext);
    // No band here: nothing is drawn (the render returns early), so the
    // last items may stay; they are read afresh when a band applies.
    if (shown.length === 0) return;
    const read = () => setItems(collectItems(shown));
    read();
    const subs = shown.map((b) => {
      try {
        return b.onDidChange(read);
      } catch {
        return null;
      }
    });
    return () => {
      for (const s of subs) s?.dispose();
    };
  }, [registry, editContext]);

  // The anchors' line boxes, read again on every push that moves text.
  useEffect(() => {
    // Without items nothing is drawn: the render walks `items`.
    if (!client || items.length === 0) return;
    const runs = { current: 0 };
    let live = true;
    const refresh = () => {
      runs.current += 1;
      const mine = runs.current;
      void readAnchors(client, items, () => live && mine === runs.current).then(
        (read) => {
          if (read !== "superseded") setAnchors(read);
        },
      );
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
      live = false;
      off();
    };
  }, [client, items]);

  const [onHeight] = useState(
    () => (key: string, px: number) =>
      setHeights((prev) => {
        if (prev.get(key) === px) return prev;
        const next = new Map(prev);
        next.set(key, px);
        return next;
      }),
  );

  // The canvas's width on screen: a balloon is kept inside it, so a page
  // wider than the view leaves its balloons on screen, over the page's
  // edge, instead of under the panels beside the canvas.
  const groupRef = useRef<SVGGElement>(null);
  const [viewWidthPx, setViewWidthPx] = useState<number | null>(null);
  const hasBands = editContext !== null && bands.length > 0;
  useEffect(() => {
    const svg = groupRef.current?.ownerSVGElement;
    if (!svg) return;
    const read = () => setViewWidthPx(svg.clientWidth || null);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [hasBands]);

  if (editContext === null || bands.length === 0) return null;
  const inv = 1 / props.camera.scale;
  const gapPt = BALLOON_GAP_PX * inv;
  // Each band is a column of its own, the first nearest the page.
  const columns = new Map<string, number>();
  let x = gapPt * 2;
  for (const band of bands) {
    columns.set(band.id, x);
    x += (band.width ?? BALLOON_WIDTH_PX) * inv + gapPt;
  }
  const inputs: BalloonInput[] = [];
  for (const it of items) {
    const anchor = anchors.get(it.key);
    if (!anchor || !props.pageRects.has(anchor.pageId as Api.PageId)) continue;
    inputs.push({
      key: it.key,
      anchor,
      heightPt: (heights.get(it.key) ?? BALLOON_HEIGHT_PX) * inv,
    });
  }
  const tops = layoutBalloons(inputs, gapPt);
  return (
    <g ref={groupRef} data-margin-band={editContext}>
      {items.map((it) => {
        const anchor = anchors.get(it.key);
        const top = tops.get(it.key);
        const pr = anchor
          ? props.pageRects.get(anchor.pageId as Api.PageId)
          : undefined;
        if (!anchor || top === undefined || !pr) return null;
        const widthPx = it.band.width ?? BALLOON_WIDTH_PX;
        const beside = pr.x + pr.w + (columns.get(it.band.id) ?? gapPt);
        // The rightmost place on screen, in page space.
        const maxX =
          viewWidthPx === null
            ? Infinity
            : (viewWidthPx - widthPx - BALLOON_GAP_PX - props.camera.tx) * inv;
        const bx = Math.max(pr.x, Math.min(beside, maxX));
        const by = pr.y + top;
        const hPx = heights.get(it.key) ?? BALLOON_HEIGHT_PX;
        const ax = pr.x + anchor.leftPt + anchor.widthPt;
        const ay = pr.y + anchor.topPt + anchor.heightPt;
        const active = anchorTouched(contentSelection, it.item.anchor);
        const color = it.item.color ?? "var(--overlay-selection)";
        return (
          <g key={it.key}>
            <polyline
              points={`${ax},${ay} ${pr.x + pr.w},${ay} ${bx},${by + 10 * inv}`}
              fill="none"
              stroke={color}
              strokeWidth={(active ? 1.5 : 1) * inv}
              strokeDasharray={active ? undefined : `${2 * inv} ${2 * inv}`}
              pointerEvents="none"
              data-margin-leader={it.item.id}
            />
            <foreignObject
              x={bx}
              y={by}
              width={widthPx * inv}
              height={(hPx + 2) * inv}
              pointerEvents="auto"
            >
              <div
                style={{
                  transform: `scale(${inv})`,
                  transformOrigin: "0 0",
                  width: widthPx,
                }}
              >
                <Balloon
                  entry={it}
                  editContext={editContext}
                  active={active}
                  widthPx={widthPx}
                  onHeight={onHeight}
                />
              </div>
            </foreignObject>
          </g>
        );
      })}
    </g>
  );
}

/** Over the page decorations and the sub-context veil, below the caret. */
export const marginBandContribution: OverlayContribution = {
  id: "paged.marginBand",
  z: 96,
  render: MarginBandRender,
};
