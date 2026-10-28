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

// Editor ADR 301 — the chrome of a header, footer or note edited in place
// (extensions ADR 349, C6): the rest of the document veiled as isolation
// mode veils it (the area being edited cut out), and a slim bar next to
// the area with its label, the bundle's commands and Close. The veil
// takes no pointer events, so a click in the body still reaches the
// canvas, moves the caret out of the sub-context's story and so leaves
// it (`state/sub-context-controller.tsx`).

import type React from "react";

import { useStrings } from "@paged-media/strings";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import type { SubContextState } from "../registries/sub-context";
import { useRegistryView } from "../state/live";
import { SUB_CONTEXT } from "../state/messages";
import { useRegistries } from "../state/registries-context";

import { isolationVeilPath } from "./isolation-dim";

/** The bar's height in screen pixels. */
const BAR_PX = 26;

/** The edited area's outline in document space, or null when its page is
 *  not laid out. */
export function subContextHole(
  state: Pick<SubContextState, "pageId" | "bounds">,
  pageRects: OverlayProps["pageRects"],
): Array<[number, number]> | null {
  const pr = pageRects.get(state.pageId);
  if (!pr) return null;
  const [top, left, bottom, right] = state.bounds;
  return [
    [pr.x + left, pr.y + top],
    [pr.x + right, pr.y + top],
    [pr.x + right, pr.y + bottom],
    [pr.x + left, pr.y + bottom],
  ];
}

const stopPointer = (e: React.PointerEvent | React.MouseEvent) =>
  e.stopPropagation();

function SubContextRender(props: OverlayProps) {
  const registries = useRegistries();
  const state = useRegistryView(registries.subContexts).current();
  const strings = useStrings();
  if (!state) return null;
  const hole = subContextHole(state, props.pageRects);
  if (!hole) return null;
  const inv = 1 / props.camera.scale;
  const [[x0, y0], [x1], , [, y3]] = [hole[0], hole[1], hole[2], hole[3]];
  const width = x1 - x0;
  const barH = BAR_PX * inv;
  // A header's bar hangs under it, a footer's and a note's sit on top.
  const barY = state.kind === "header" ? y3 : y0 - barH;
  const label =
    state.label ??
    strings.t(
      state.kind === "header"
        ? SUB_CONTEXT.header
        : state.kind === "footer"
          ? SUB_CONTEXT.footer
          : SUB_CONTEXT.note,
    );
  const commands = (state.commands ?? [])
    .map((id) => registries.commands.get(id))
    .filter((c) => c !== undefined);
  return (
    <g data-sub-context={state.kind}>
      <path
        d={isolationVeilPath(hole)}
        fillRule="evenodd"
        style={{ fill: "var(--overlay-isolation-dim)" }}
        pointerEvents="none"
        data-sub-context-veil
      />
      <rect
        x={x0}
        y={y0}
        width={width}
        height={y3 - y0}
        fill="none"
        stroke="var(--overlay-selection)"
        strokeWidth={inv}
        strokeDasharray={`${4 * inv} ${3 * inv}`}
        pointerEvents="none"
      />
      <foreignObject
        x={x0}
        y={barY}
        width={width}
        height={barH}
        pointerEvents="auto"
      >
        <div
          role="toolbar"
          aria-label={label}
          data-sub-context-bar
          onPointerDown={stopPointer}
          onPointerUp={stopPointer}
          onDoubleClick={stopPointer}
          style={{
            transform: `scale(${inv})`,
            transformOrigin: "0 0",
            width: width / inv,
            height: BAR_PX,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 6px",
            boxSizing: "border-box",
            fontSize: 12,
            color: "var(--pg-fg)",
            background: "var(--pg-bg)",
            borderTop: "1px solid var(--overlay-selection)",
            borderBottom: "1px solid var(--overlay-selection)",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span style={{ flex: 1 }} />
          {commands.map((c) => (
            <button
              key={c.id}
              type="button"
              data-command={c.id}
              onClick={() => void registries.commands.invoke(c.id)}
            >
              {c.title}
            </button>
          ))}
          <button
            type="button"
            data-sub-context-close
            title={strings.t(SUB_CONTEXT.closeTitle)}
            onClick={() => registries.subContexts.exit()}
          >
            {strings.t(SUB_CONTEXT.close)}
          </button>
        </div>
      </foreignObject>
    </g>
  );
}

/** Over the isolation veil and the guides, below the caret (z 600). */
export const subContextContribution: OverlayContribution = {
  id: "paged.subContext",
  z: 95,
  render: SubContextRender,
};
