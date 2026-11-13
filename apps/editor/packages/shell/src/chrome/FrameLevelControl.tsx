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

// The Frame · Content · Edit control (editor ADR 1213; the UX strategy's
// §3.2; UXI-CTX-013). A compact segmented control in the context toolbar
// for the selected frame, or the frame the active context was entered on:
// which level is being edited, and a press to change it. Shown only for a
// frame that has more than one level (a picture frame; content a module
// owns). Going up leaves the levels above through the exit resolver
// (ADR 1212); going down enters the level — "Edit image" is D-05's
// explicit action. It sits in a bar of fixed height, so it never moves
// the page (UXI-CTX-008).

import { useStrings } from "@paged-media/strings";
import type { ElementId } from "@paged-media/client";

import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useEditContextStack } from "../state/edit-context-stack";
import { useEditContextEntry } from "../state/use-edit-context-entry";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useSelection } from "../state/selection-context";
import { useSelectionObjectType } from "../state/use-selection-object-type";
import {
  currentFrameLevel,
  frameLevelDepth,
  frameLevels,
  imageEditorOf,
  type FrameLevel,
} from "../state/frame-content";
import { FRAME_CONTENT } from "./messages";

function sameElement(a: ElementId, b: ElementId): boolean {
  const x = a as unknown as { kind?: string; id?: unknown };
  const y = b as unknown as { kind?: string; id?: unknown };
  return x.kind === y.kind && String(x.id) === String(y.id);
}

/** The level control, where an engine client is wired. */
export function FrameLevelControl() {
  return useOptionalCanvasClient() ? <FrameLevels /> : null;
}

function FrameLevels() {
  const strings = useStrings();
  const contexts = useEditContextStack();
  const { elementSelection, elementGeometry } = useSelection();
  const registries = useRegistries();
  const editContexts = useRegistryView(registries.editContexts);
  const owned = useSelectionObjectType();
  const { enterFrameLevel } = useEditContextEntry();

  const frame =
    contexts.active?.scopeRoot ??
    (elementSelection.length === 1 ? elementSelection[0]! : null);
  if (!frame) return null;
  const geometry = elementGeometry.find((g) => sameElement(g.id, frame));
  const imageEditor = imageEditorOf(editContexts.list());
  const ownerContext = owned?.editContext ?? null;
  const owner =
    ownerContext && ownerContext.type !== imageEditor?.type
      ? ownerContext
      : null;
  const levels = frameLevels({
    hasImage: geometry?.hasImage === true,
    imageEditor,
    owner,
  });
  if (levels.length < 2) return null;
  const current = currentFrameLevel(levels, contexts.stack, frame);
  const currentIndex = levels.findIndex((l) => l.id === current);

  const go = (level: FrameLevel, index: number) => {
    if (index === currentIndex) return;
    if (index < currentIndex) {
      // Up: leave the frame's levels above `level`. A level that was
      // skipped on the way down (Edit image entered from the frame) is
      // entered once the ones above it have left.
      const start = frameLevelDepth(contexts.stack, frame);
      if (level.id === "frame") {
        void contexts.leaveTo(start, "breadcrumb");
        return;
      }
      const at = contexts.stack.findIndex(
        (f, i) => i >= start && f.type === level.contextType,
      );
      if (at >= 0) {
        void contexts.leaveTo(at + 1, "breadcrumb");
        return;
      }
      void contexts.leaveTo(start, "breadcrumb").then((left) => {
        if (left) void enterFrameLevel(frame, level.id, null);
      });
      return;
    }
    void enterFrameLevel(frame, level.id, owner ? level.contextType : null);
  };

  return (
    <div
      role="radiogroup"
      aria-label={strings.t(FRAME_CONTENT.label)}
      data-frame-levels=""
      data-frame-level-current={current}
      style={groupStyle}
    >
      {levels.map((level, i) => {
        const on = i === currentIndex;
        return (
          <button
            key={level.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-frame-level={level.id}
            data-active={on ? "true" : undefined}
            onClick={() => go(level, i)}
            style={{
              ...segmentStyle,
              background: on ? "var(--selected-bg)" : "transparent",
              color: on ? "var(--pg-primary)" : "var(--pg-muted-fg)",
              fontWeight: on ? 600 : 400,
            }}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

const groupStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  height: 24,
  padding: 2,
  gap: 2,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-border)",
};

const segmentStyle: React.CSSProperties = {
  height: 20,
  padding: "0 8px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  font: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer",
};
