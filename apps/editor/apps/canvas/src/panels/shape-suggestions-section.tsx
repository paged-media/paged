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

// The inspector's Shape suggestions (paged.draw ADR 370): quick actions for
// the one selected path, chosen by `suggestShapeActions` from what the
// shape is. Each runs the editor's own command (or, for Smooth, one batch
// of point ops): one undo step, nothing new to learn.

import { useEffect, useState } from "react";

import type { ElementId } from "@paged-media/client";
import {
  useCanvasClient,
  useRegistries,
  useRegistryView,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

import { pointBatch } from "./anchor-points";
import {
  smoothCornerOps,
  suggestShapeActions,
  type ShapeFacts,
  type ShapeSuggestionId,
} from "./shape-suggestions";

const M = defineMessages("app.shapeSuggestions", {
  title: "Shape suggestions",
  roundCorners: "Round corners",
  roundCornersHint: "Round every corner of the shape (12 pt)",
  smooth: "Smooth",
  smoothHint: "Make every corner point a smooth point",
  simplify: "Simplify",
  simplifyHint: "Fewer anchors along the same outline (last used values)",
  offset: "Offset path",
  offsetHint: "A parallel outline around the shape (last used values)",
  repeat: "Repeat",
  repeatHint: "Copies around a ring, rebuilt when the shape changes",
  mirror: "Mirror",
  mirrorHint: "A reflection across an axis, rebuilt when the shape changes",
  note: "Applies on click to the selected shape; one undo step.",
});

const LABEL: Record<ShapeSuggestionId, { label: string; hint: string }> = {
  roundCorners: { label: M.roundCorners, hint: M.roundCornersHint },
  smooth: { label: M.smooth, hint: M.smoothHint },
  simplify: { label: M.simplify, hint: M.simplifyHint },
  offset: { label: M.offset, hint: M.offsetHint },
  repeat: { label: M.repeat, hint: M.repeatHint },
  mirror: { label: M.mirror, hint: M.mirrorHint },
};

/** The selected path's facts, re-read when the document changes. */
function useShapeFacts(id: ElementId): ShapeFacts | null {
  const client = useCanvasClient();
  const [facts, setFacts] = useState<{
    key: string;
    shape: ShapeFacts | null;
  } | null>(null);
  const key = JSON.stringify(id);
  useEffect(() => {
    let alive = true;
    // `key` names the element by value: a new object for the same element
    // is not a new element.
    const target = JSON.parse(key) as ElementId;
    const read = () => {
      void client
        .pathAnchors(target)
        .then((reply) => {
          if (!alive) return;
          setFacts({
            key,
            shape: reply
              ? {
                  kind: target.kind,
                  anchors: reply.anchors,
                  subpathOpen: reply.subpathOpen,
                }
              : null,
          });
        })
        .catch(() => {
          if (alive) setFacts({ key, shape: null });
        });
    };
    read();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      )
        read();
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, key]);
  return facts?.key === key ? facts.shape : null;
}

export function ShapeSuggestionsSection({ id }: { id: ElementId }) {
  const strings = useStrings();
  const client = useCanvasClient();
  const commands = useRegistryView(useRegistries().commands);
  const shape = useShapeFacts(id);
  if (!shape) return null;
  const suggestions = suggestShapeActions(
    shape,
    (command) => commands.get(command) !== undefined,
  );
  if (suggestions.length === 0) return null;

  const run = (command: string | null) => {
    if (command) {
      void commands.invoke(command);
      return;
    }
    const ops = smoothCornerOps(shape);
    if (ops.length > 0) void client.mutate(pointBatch(id, ops) as never);
  };

  return (
    <div
      data-properties-section="shape-suggestions"
      className="flex flex-col gap-2"
    >
      <div className="pg-label">{strings.t(M.title)}</div>
      <div className="flex flex-wrap gap-[5px]" role="group">
        {suggestions.map((s) => (
          <button
            type="button"
            key={s.id}
            data-shape-suggestion={s.id}
            data-applies-on-click=""
            title={strings.t(LABEL[s.id].hint)}
            onClick={() => run(s.command)}
            className="h-[26px] px-[10px] rounded-[6px] border border-input bg-background text-xs"
            style={{ color: "var(--pg-fg)" }}
          >
            {strings.t(LABEL[s.id].label)}
          </button>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">{strings.t(M.note)}</div>
    </div>
  );
}
