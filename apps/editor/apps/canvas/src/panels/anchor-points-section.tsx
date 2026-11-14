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

// The inspector's Points section (the UX strategy's §7.1; paged.draw ADR
// 370): with anchors selected by Direct Selection the Properties panel
// edits THOSE points, not the frame around them. One anchor shows its
// position; several show their bounds, and can be lined up on their
// average. Corner / Smooth converts them; Delete removes them. Every edit
// is one batch, one undo step (UXI-DRW-005, UXI-DRW-006).

import { useState, useSyncExternalStore, type ReactNode } from "react";

import type { ElementId } from "@paged-media/client";
import {
  useCanvasClient,
  type PathEditSession,
  type PathEditView,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";
import { LengthInput } from "@paged-media/ui";

import {
  alignAnchorsOps,
  curveTypeOps,
  moveAnchorsOps,
  pointBatch,
  removeAnchorsOps,
  summarizePoints,
  type PointOp,
} from "./anchor-points";

const M = defineMessages("app.anchorPoints", {
  count: "{count, plural, one {# anchor selected} other {# anchors selected}}",
  x: "X",
  y: "Y",
  type: "Point type",
  corner: "Corner",
  smooth: "Smooth",
  mixed: "Mixed",
  alignH: "Align horizontally",
  alignHTitle: "Give the selected anchors one y, their average",
  alignV: "Align vertically",
  alignVTitle: "Give the selected anchors one x, their average",
  remove: "Delete points",
  note: "Edits the selected anchors of the path, not its frame. Each change is one undo step.",
  failed: "The path did not change: {reason}",
});

const noView = () => null;
const noSubscribe = () => () => {};

/** The path-edit session's view, live. */
function useView(session: PathEditSession | null): PathEditView | null {
  return useSyncExternalStore(
    session ? (l) => session.subscribe(l) : noSubscribe,
    session ? () => session.getView() : noView,
    session ? () => session.getView() : noView,
  );
}

export function AnchorPointsSection({
  session,
}: {
  session: PathEditSession | null;
}) {
  const strings = useStrings();
  const client = useCanvasClient();
  const view = useView(session);
  const [status, setStatus] = useState<string | null>(null);
  const selected = view?.selected ?? [];
  const summary = view ? summarizePoints(view.anchors, selected) : null;
  if (!view || !summary) return null;

  /** Send `build(inner table, transform)`'s ops as one batch. */
  const send = async (
    build: (
      inner: ReadonlyArray<{
        anchor: [number, number];
        left: [number, number];
        right: [number, number];
      }>,
      transform: [number, number, number, number, number, number] | null,
    ) => PointOp[],
  ) => {
    setStatus(null);
    const target: ElementId = view.target;
    const reply = await client.pathAnchors(target).catch(() => null);
    if (!reply) return;
    const ops = build(
      reply.anchors as never,
      (reply.itemTransform ?? null) as never,
    );
    if (ops.length === 0) return;
    const result = await client.mutate(pointBatch(target, ops) as never);
    if (result.kind === "mutationFailed") {
      const why = (result as { payload?: { error?: { kind?: string } } })
        .payload?.error?.kind;
      setStatus(strings.t(M.failed, { reason: why ?? "refused" }));
    }
  };

  const moveTo = (axis: 0 | 1, valuePt: number) => {
    const from = axis === 0 ? summary.x : summary.y;
    const delta = valuePt - from;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) return;
    void send((inner, m) =>
      moveAnchorsOps(
        inner,
        m,
        selected,
        axis === 0 ? delta : 0,
        axis === 1 ? delta : 0,
      ),
    );
  };

  return (
    <div
      data-points-section
      data-points-count={summary.count}
      data-points-kind={summary.kind}
      className="flex flex-col gap-2"
    >
      <div className="pg-label">
        {strings.t(M.count, { count: summary.count })}
      </div>
      <div className="grid grid-cols-[24px_1fr_24px_1fr] items-center gap-2">
        <span className="text-xs text-muted-foreground">{strings.t(M.x)}</span>
        <span data-points-x>
          <LengthInput
            aria-label={strings.t(M.x)}
            valuePt={summary.x}
            onChangePt={() => {}}
            onCommitPt={(v) => moveTo(0, v)}
          />
        </span>
        <span className="text-xs text-muted-foreground">{strings.t(M.y)}</span>
        <span data-points-y>
          <LengthInput
            aria-label={strings.t(M.y)}
            valuePt={summary.y}
            onChangePt={() => {}}
            onCommitPt={(v) => moveTo(1, v)}
          />
        </span>
      </div>
      <div
        className="flex items-center gap-2"
        role="group"
        aria-label={strings.t(M.type)}
      >
        <span className="text-xs text-muted-foreground flex-1">
          {strings.t(M.type)}
          {summary.kind === "mixed" ? ` · ${strings.t(M.mixed)}` : ""}
        </span>
        <PointButton
          action="corner"
          pressed={summary.kind === "corner"}
          onClick={() => void send(() => curveTypeOps(selected, false))}
        >
          {strings.t(M.corner)}
        </PointButton>
        <PointButton
          action="smooth"
          pressed={summary.kind === "smooth"}
          onClick={() => void send(() => curveTypeOps(selected, true))}
        >
          {strings.t(M.smooth)}
        </PointButton>
      </div>
      {summary.count > 1 ? (
        <div className="flex flex-wrap gap-2">
          <PointButton
            action="align-h"
            title={strings.t(M.alignHTitle)}
            onClick={() =>
              void send((inner, m) =>
                alignAnchorsOps(inner, m, view.anchors, selected, "horizontal"),
              )
            }
          >
            {strings.t(M.alignH)}
          </PointButton>
          <PointButton
            action="align-v"
            title={strings.t(M.alignVTitle)}
            onClick={() =>
              void send((inner, m) =>
                alignAnchorsOps(inner, m, view.anchors, selected, "vertical"),
              )
            }
          >
            {strings.t(M.alignV)}
          </PointButton>
        </div>
      ) : null}
      <div>
        <PointButton
          action="delete"
          onClick={() => void send(() => removeAnchorsOps(selected))}
        >
          {strings.t(M.remove)}
        </PointButton>
      </div>
      <div
        className="text-xs text-muted-foreground"
        style={{ lineHeight: 1.5 }}
      >
        {strings.t(M.note)}
      </div>
      {status ? (
        <div
          className="text-xs"
          data-points-error
          style={{ color: "var(--status-error)" }}
        >
          {status}
        </div>
      ) : null}
    </div>
  );
}

/** A small action button of the section (`data-points-action`). */
function PointButton({
  action,
  pressed,
  title,
  onClick,
  children,
}: {
  action: string;
  pressed?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-points-action={action}
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className="h-[26px] px-[10px] rounded-[6px] border border-input text-xs"
      style={{
        background: pressed ? "var(--selected-bg)" : "var(--pg-bg)",
        color: pressed ? "var(--pg-primary)" : "var(--pg-fg)",
      }}
    >
      {children}
    </button>
  );
}
