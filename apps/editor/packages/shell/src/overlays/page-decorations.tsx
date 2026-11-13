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

import { useSyncExternalStore, type ReactNode } from "react";

import type { PageId } from "@paged-media/client";
import { defineMessages, t } from "@paged-media/strings";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useDocument } from "../state/document-context";
import { getViewToggle, subscribeViewToggles } from "../state/view-toggles";
import { useEditorScope } from "../state/editor-scope";

const M = defineMessages("shell.pageDecorations", {
  caption: "Page {n}",
});

/** The pasteboard a caption needs under its page, CSS px. */
export const CAPTION_ROOM_PX = 18;

interface CaptionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where page `i`'s caption goes (editor ADR "Page lenses and semantic
 * zoom", UX audit F-57): under the page while `CAPTION_ROOM_PX` of
 * pasteboard is free below it at `scale`, else beside its top-left corner,
 * outside the page, so it never lies on the next page's content (the
 * stacked pages' 24 pt gap is 2 px at 10 %).
 */
export function captionPlace(
  rects: ReadonlyArray<CaptionRect>,
  i: number,
  scale: number,
): "below" | "side" {
  const r = rects[i];
  if (!r) return "below";
  const bottom = r.y + r.h;
  let room = Infinity;
  rects.forEach((q, j) => {
    if (j === i) return;
    const overlapsX = q.x < r.x + r.w && q.x + q.w > r.x;
    if (overlapsX && q.y >= bottom) room = Math.min(room, q.y - bottom);
  });
  return room * scale >= CAPTION_ROOM_PX ? "below" : "side";
}

/**
 * Per-page labels: "Page N" caption under the page (or beside it, when
 * zoomed too far out for the gap below), plus heading-
 * anchor badges (Tier 3 resolution data). The caption count comes
 * from the registry's `pageRects` map; anchor badges come from the
 * resolution table on DocumentContext, and only when View ▸ Show
 * heading anchors asks for them — they are a diagnostic of the
 * resolver, not chrome every document with a heading should wear.
 */
function PageDecorationsRender(props: OverlayProps) {
  const { resolution } = useDocument();
  const scope = useEditorScope();
  const showAnchors = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "headingAnchors"),
  );
  // Captions and badges are editing chrome: the overlay host hides them
  // in a proof (state/editing-aids.ts).
  const inv = 1 / props.camera.scale;
  const out: ReactNode[] = [];

  const rects = [...props.pageRects.values()];
  let i = 0;
  for (const [pageId, r] of props.pageRects) {
    const place = captionPlace(rects, i, props.camera.scale);
    const below = place === "below";
    const x = below ? r.x + r.w / 2 : r.x - 8 * inv;
    const y = below ? r.y + r.h + 14 * inv : r.y + 11 * inv;
    out.push(
      <g
        key={`caption:${pageId}`}
        data-page-caption={i + 1}
        data-caption-place={place}
        transform={`translate(${x}, ${y}) scale(${inv})`}
      >
        <text
          textAnchor={below ? "middle" : "end"}
          fontSize={11}
          fontFamily="var(--font-sans)"
          fill="var(--pg-muted-fg)"
        >
          {t(M.caption, { n: i + 1 })}
        </text>
      </g>,
    );
    i += 1;
  }

  if (resolution && showAnchors) {
    out.push(...renderAnchorBadges(resolution, props, inv));
  }

  return <>{out}</>;
}

function renderAnchorBadges(
  resolution: NonNullable<ReturnType<typeof useDocument>["resolution"]>,
  props: OverlayProps,
  inv: number,
): ReactNode[] {
  type Entry = {
    anchorId: string;
    text: string;
    level: number;
    pageNumber: number;
  };
  const byPage = new Map<PageId, Entry[]>();
  for (const [anchorId, pos] of Object.entries(resolution.numbering)) {
    if (!pos.pageId) continue;
    const list = byPage.get(pos.pageId) ?? [];
    list.push({
      anchorId,
      text: pos.text ?? "",
      level: pos.level ?? 0,
      pageNumber: pos.pageNumber,
    });
    byPage.set(pos.pageId, list);
  }

  const badges: ReactNode[] = [];
  for (const [pageId, anchors] of byPage) {
    const r = props.pageRects.get(pageId);
    if (!r) continue;
    anchors.sort((a, b) => a.level - b.level);
    anchors.forEach((a, i) => {
      const cx = r.x + 8 * inv;
      const cy = r.y + (12 + i * 22) * inv;
      const trimmed = a.text.length > 28 ? `${a.text.slice(0, 27)}…` : a.text;
      const label = `${a.pageNumber} — ${trimmed}`;
      const labelWidthPx = 8 + label.length * 6.0;
      badges.push(
        <g
          key={`badge:${pageId}:${a.anchorId}`}
          data-anchor-badge={a.anchorId}
          transform={`translate(${cx}, ${cy}) scale(${inv})`}
        >
          <rect
            x={0}
            y={-9}
            width={labelWidthPx}
            height={16}
            rx={3}
            fill="var(--status-approved)"
            fillOpacity="0.92"
          />
          <text
            x={4}
            y={3}
            fontSize={10}
            fontFamily="var(--font-sans)"
            fill="white"
          >
            {label}
          </text>
        </g>,
      );
    });
  }
  return badges;
}

export const pageDecorationsContribution: OverlayContribution = {
  id: "paged.page-decorations",
  render: PageDecorationsRender,
  z: 50,
};
