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

// Document X-Ray on the canvas (editor ADR 1226; the UX strategy's Concept
// A): with View ▸ X-Ray on, every page item is outlined in the colour of
// what shapes it — a text frame by its paragraph style, any other item by
// its object style, one with neither as set on the item — with a label,
// and a legend beside each page. Hovering a label says the winning source
// in full (the style and what it is based on, a lock and its reason). The
// facts are the engine's (`explain`, overview; engine ADR 1307). Diagnostic
// chrome: hidden in Proof view, never printed; with the view off it reads
// nothing.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  changesTheDocument,
  type ElementGeometryItem,
  type ElementId,
  type Explanation,
} from "@paged-media/client";
import {
  applyAffine,
  getViewToggle,
  subscribeViewToggles,
  useCanvasClient,
  useEditorScope,
  type OverlayContribution,
  type OverlayProps,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";


const M = defineMessages("app.xrayOverlay", {
  noStyle: "Set on the item",
  text: "Text: paragraph style {chain}",
  object: "Object style {chain}",
  own: "No object style: its look is set on the item",
  locked: "Locked: {why}",
  legend: "X-Ray",
});

/** An item's outline in document points (its corners through its
 *  transform, moved by its page's place) and its top-left corner; null
 *  off the pages. PURE. */
export function frameEdgePointsOf(
  item: Pick<ElementGeometryItem, "bounds" | "itemTransform">,
  page: { x: number; y: number } | undefined,
): { points: string; topLeft: [number, number] } | null {
  if (!page || item.bounds.length < 4) return null;
  const [top, left, bottom, right] = item.bounds as [
    number,
    number,
    number,
    number,
  ];
  const corners = (
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const
  ).map(([x, y]) => {
    const [px, py] = applyAffine(item.itemTransform, x, y);
    return [page.x + px, page.y + py] as [number, number];
  });
  return {
    points: corners.map(([x, y]) => `${x},${y}`).join(" "),
    topLeft: corners[0]!,
  };
}

/** The most items one read explains: a page of a catalogue has hundreds;
 *  past this the X-Ray shows the first ones. */
const MAX_ITEMS = 600;

/** One outlined item. */
export interface XrayItem {
  id: ElementId;
  pageId: string;
  geometry: ElementGeometryItem;
  /** What the item is coloured by: a style name, or "" for set on the
   *  item. */
  key: string;
  /** Its explanation's overview. */
  facts: Explanation;
}

interface SpreadMembers {
  members?: ReadonlyArray<{ id: ElementId }>;
}

/** What colours `x`: the paragraph style of a text frame's text, else the
 *  object style, else nothing (set on the item). PURE. */
export function xrayKey(x: Explanation): string {
  const para = x.text?.paragraphStyle.chain[0];
  if (para) return para.name;
  const obj = x.objectStyle?.chain[0];
  return obj ? obj.name : "";
}

/** A colour per key, stable for a key list (sorted): a golden-angle hue
 *  walk, so neighbours differ. "" (set on the item) is grey. PURE. */
export function xrayPalette(keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  [...new Set(keys)]
    .filter((k) => k !== "")
    .sort()
    .forEach((k, i) => out.set(k, `hsl(${Math.round((i * 137.5) % 360)} 70% 45%)`));
  out.set("", "var(--overlay-guide)");
  return out;
}

/** Every top-level page item, its geometry and its overview; null when a
 *  newer read started or the read failed. Outside the component: no
 *  conditional in a `try` (ADR 229). */
async function readXray(
  client: ReturnType<typeof useCanvasClient>,
  current: () => boolean,
): Promise<XrayItem[] | null> {
  try {
    const spreads = await client.collection<SpreadMembers>("spreads");
    if (!current()) return null;
    const ids: ElementId[] = [];
    for (const s of spreads) for (const m of s.members ?? []) ids.push(m.id);
    const wanted = ids.slice(0, MAX_ITEMS);
    if (wanted.length === 0) return [];
    const geometry = await client.elementGeometry(wanted);
    const onPage = geometry.filter((g) => g.pageId);
    const facts = await Promise.all(
      onPage.map((g) => client.explain(g.id, { aspect: "overview" })),
    );
    if (!current()) return null;
    return onPage.map((g, i) => ({
      id: g.id,
      pageId: String(g.pageId),
      geometry: g,
      key: xrayKey(facts[i]!),
      facts: facts[i]!,
    }));
  } catch {
    return null;
  }
}

function XrayRender(props: OverlayProps) {
  const scope = useEditorScope();
  const on = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "xray"),
    () => false,
  );
  if (!on) return null;
  return <XrayItems {...props} />;
}

function XrayItems(props: OverlayProps) {
  const client = useCanvasClient();
  const strings = useStrings();
  const [items, setItems] = useState<XrayItem[] | null>(null);
  const runRef = useRef(0);
  useEffect(() => {
    const refresh = () => {
      const run = ++runRef.current;
      void readXray(client, () => run === runRef.current).then((read) => {
        if (read) setItems(read);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (changesTheDocument(msg)) refresh();
    });
  }, [client]);
  const t = (k: string, p?: Record<string, string | number>) =>
    strings.t(k, p);
  if (!items) return null;
  const palette = xrayPalette(items.map((i) => i.key));
  const inv = 1 / props.camera.scale;
  const byPage = new Map<string, Set<string>>();
  for (const i of items) {
    const keys = byPage.get(i.pageId) ?? new Set<string>();
    keys.add(i.key);
    byPage.set(i.pageId, keys);
  }
  const title = (i: XrayItem) => {
    const f = i.facts;
    const lines: string[] = [];
    if (f.text)
      lines.push(
        t(M.text, {
          chain: f.text.paragraphStyle.chain.map((s) => s.name).join(" ← "),
        }),
      );
    if (f.objectStyle)
      lines.push(
        t(M.object, {
          chain: f.objectStyle.chain.map((s) => s.name).join(" ← "),
        }),
      );
    else if (!f.text) lines.push(t(M.own));
    if (f.lock.locked)
      lines.push(
        t(M.locked, {
          why: f.lock.reasons
            .map((r) => (r.kind === "layer" ? r.name : r.kind))
            .join(", "),
        }),
      );
    return lines.join("\n");
  };
  return (
    <g data-xray-overlay={items.length}>
      {items.map((i) => {
        const pr = props.pageRects.get(i.pageId as never);
        const points = frameEdgePointsOf(i.geometry, pr);
        if (!pr || !points) return null;
        const colour = palette.get(i.key) ?? "var(--overlay-guide)";
        const [lx, ly] = points.topLeft;
        return (
          <g
            key={`${i.id.kind}:${String(i.id.id)}`}
            data-xray-item={String(i.id.id)}
            data-xray-key={i.key}
            data-xray-locked={i.facts.lock.locked ? "true" : undefined}
          >
            <polygon
              points={points.points}
              fill="none"
              stroke={colour}
              strokeWidth={2}
              strokeDasharray={i.facts.lock.locked ? "4 3" : undefined}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            <g
              transform={`translate(${lx}, ${ly}) scale(${inv})`}
              style={{ pointerEvents: "all", cursor: "help" }}
              data-xray-label={i.key}
            >
              <title>{title(i)}</title>
              <rect
                x={0}
                y={-14}
                width={Math.max(24, (i.key || t(M.noStyle)).length * 6 + 8)}
                height={13}
                rx={2}
                fill={colour}
              />
              <text
                x={4}
                y={-4}
                fontSize={9}
                fontFamily="var(--font-sans)"
                fill="white"
                pointerEvents="none"
              >
                {i.key || t(M.noStyle)}
              </text>
            </g>
          </g>
        );
      })}
      {[...byPage].map(([pageId, keys]) => {
        const pr = props.pageRects.get(pageId as never);
        if (!pr) return null;
        const sorted = [...keys].sort();
        return (
          <g
            key={`legend:${pageId}`}
            data-xray-legend={pageId}
            transform={`translate(${pr.x + pr.w + 8 * inv}, ${pr.y}) scale(${inv})`}
            pointerEvents="none"
          >
            <text
              y={10}
              fontSize={10}
              fontWeight={700}
              fontFamily="var(--font-sans)"
              fill="var(--pg-muted-fg)"
            >
              {t(M.legend)}
            </text>
            {sorted.map((k, n) => (
              <g key={k || "own"} transform={`translate(0, ${16 + n * 14})`}>
                <rect width={10} height={10} fill={palette.get(k)} rx={2} />
                <text
                  x={14}
                  y={9}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="var(--pg-fg)"
                  data-xray-legend-key={k}
                >
                  {k || t(M.noStyle)}
                </text>
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

export const xrayOverlayContribution: OverlayContribution = {
  id: "paged.overlay.xray",
  render: XrayRender,
  // Over the frame edges (45), under the issue markers (62) and the
  // selection chrome (200).
  z: 58,
};
