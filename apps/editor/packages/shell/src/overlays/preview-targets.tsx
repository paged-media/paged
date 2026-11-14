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

// The preview's outlines (editor ADRs 1233, 1234): every object a previewed
// action or a proposed change will touch, dashed, in the review colour, the
// one the list points at drawn stronger. Text targets outline the frames of
// their story. Overlay chrome: it never prints, never takes the pointer and
// changes nothing.

import { useEffect, useState, useSyncExternalStore } from "react";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";

import { useObjectModel } from "../catalog/object-model";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useEditorScope } from "../state/editor-scope";
import { previewTargetsStore } from "../state/preview-targets";
import { applyAffine } from "./affine";

interface Outline {
  address: string;
  geometry: ElementGeometryItem;
}

/** A story range's address → its story id. */
function storyOf(address: string): string | null {
  const m = /^(?:storyRange|story):([^@]+)(?:@|$)/.exec(address);
  return m ? m[1]! : null;
}

function PreviewTargetsRender(props: OverlayProps) {
  const scope = useEditorScope();
  const store = previewTargetsStore(scope);
  const targets = useSyncExternalStore(store.subscribe, store.get, store.get);
  const client = useOptionalCanvasClient();
  const model = useObjectModel();
  // The outlines read for one address list; drawn only while it is the
  // current one (a cleared preview draws nothing without clearing state).
  const [read, setRead] = useState<{ key: string; outlines: Outline[] }>({
    key: "",
    outlines: [],
  });
  const key = targets ? JSON.stringify(targets.addresses) : "";
  const outlines = read.key === key ? read.outlines : [];

  useEffect(() => {
    let live = true;
    const addresses = key ? (JSON.parse(key) as string[]) : [];
    if (!client || !model || addresses.length === 0) return;
    void (async () => {
      const items: Array<{ address: string; id: ElementId }> = [];
      for (const address of addresses) {
        const story = storyOf(address);
        if (story) {
          const links = await client.frameChain(story).catch(() => []);
          for (const l of links)
            items.push({
              address,
              id: { kind: "textFrame", id: l.frameId } as ElementId,
            });
          continue;
        }
        const id = model.elementIdOf?.(address) ?? null;
        if (id) items.push({ address, id });
      }
      if (items.length === 0) return [];
      const geometry = await client
        .elementGeometry(items.map((i) => i.id))
        .catch(() => [] as ElementGeometryItem[]);
      const byKey = new Map(
        geometry.map((g) => [JSON.stringify(g.id), g] as const),
      );
      return items.flatMap((i) => {
        const g = byKey.get(JSON.stringify(i.id));
        return g ? [{ address: i.address, geometry: g }] : [];
      });
    })().then((next) => {
      if (live && next) setRead({ key, outlines: next });
    });
    return () => {
      live = false;
    };
    // `key` is the address list as text: a new publish of the same list
    // reads nothing again.
  }, [client, model, key]);

  if (!targets || outlines.length === 0) {
    return targets ? (
      <g data-preview-targets={targets.owner} data-preview-count={0} />
    ) : null;
  }
  return (
    <g
      data-preview-targets={targets.owner}
      data-preview-count={outlines.length}
      pointerEvents="none"
    >
      {outlines.map((o, i) => {
        const g = o.geometry;
        const pr = g.pageId ? props.pageRects.get(g.pageId) : undefined;
        if (!pr) return null;
        const [top, left, bottom, right] = g.bounds;
        const pts = (
          [
            [left, top],
            [right, top],
            [right, bottom],
            [left, bottom],
          ] as const
        ).map(([x, y]) => applyAffine(g.itemTransform, x, y));
        const focused = targets.focus === o.address;
        return (
          <polygon
            key={`${o.address}#${i}`}
            data-preview-target={o.address}
            data-focused={focused ? "true" : undefined}
            points={pts.map(([x, y]) => `${pr.x + x},${pr.y + y}`).join(" ")}
            style={{ fill: "var(--status-review)" }}
            fillOpacity={focused ? 0.16 : 0.07}
            stroke="var(--status-review)"
            strokeWidth={focused ? 2.5 : 1.5}
            strokeDasharray="5 3"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

export const previewTargetsContribution: OverlayContribution = {
  id: "paged.overlay.previewTargets",
  render: PreviewTargetsRender,
  // Over the issue markers (62), under hover (150) and the selection (100+).
  z: 90,
};
