/*
 * This file is part of paged (https://paged.media).
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

// The CONTEXTUAL TASK BAR (WP8.2, image ADR 486): while the image has a
// selection, a small bar sits under it on the canvas with Generative Fill
// (and its prompt), Remove and Select Subject. The buttons call the same ML
// controller the commands of the same names call, so the model, the undo
// step and the refusal text are the commands' own. It draws in document
// space inside the overlay's camera group, but at screen size: pan and zoom
// move it, they do not scale it. With no selection (or no image) it renders
// nothing.

import { useEffect, useState, type ReactElement } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import type { BundleHost, OverlayProps } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import { imageToPage, resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";

const M = defineMessages("image.taskBar", {
  label: "Selection actions",
  prompt: "Describe what to fill in",
  fill: "Generative fill",
  remove: "Remove",
  subject: "Select subject",
});

/** The bar's size and gap on screen, CSS px. */
const BAR_WIDTH = 440;
const BAR_HEIGHT = 34;
const GAP = 8;

export function makeTaskBarOverlay(
  host: BundleHost,
  session: ImageSession,
  panelId: string,
) {
  function TaskBar(props: OverlayProps): ReactElement | null {
    const live = useLive(session, onDidChangeOf);
    const [prompt, setPrompt] = useState("");
    const [fit, setFit] = useState<FitTransform | null>(null);
    const state = live.state();
    const source = state.source;
    const sel = state.selection;
    const elementId = source?.elementId ?? null;
    const width = source?.width ?? 0;
    const height = source?.height ?? 0;

    useEffect(() => {
      let current = true;
      void resolveFrameFit(host, { elementId, width, height }, "task bar").then(
        (f) => {
          if (current) setFit(f);
        },
      );
      return () => {
        current = false;
      };
    }, [elementId, width, height]);

    if (!source || !sel || sel.w <= 0 || sel.h <= 0 || !fit) return null;
    const page = props.pageRects.get(fit.pageId);
    if (!page) return null;
    const k = 1 / props.camera.scale;
    const [cx, bottom] = imageToPage(fit, [sel.x + sel.w / 2, sel.y + sel.h]);
    const busy = state.ml.busy;
    const ml = () => live.ml();
    return (
      <g data-image-task-bar="">
        <foreignObject
          x={page.x + cx - (BAR_WIDTH * k) / 2}
          y={page.y + bottom + GAP * k}
          width={BAR_WIDTH * k}
          height={BAR_HEIGHT * k}
        >
          <div
            role="toolbar"
            aria-label={t(M.label)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              boxSizing: "border-box",
              width: BAR_WIDTH,
              height: BAR_HEIGHT,
              transform: `scale(${k})`,
              transformOrigin: "0 0",
              display: "flex",
              gap: 6,
              alignItems: "center",
              padding: "0 6px",
              borderRadius: 6,
              background: "var(--pg-surface, #fff)",
              color: "var(--pg-text, #111)",
              border: "1px solid var(--pg-border, #bbb)",
              pointerEvents: "auto",
              font: "12px system-ui, sans-serif",
            }}
          >
            <input
              type="text"
              data-image-task-bar-prompt=""
              aria-label={t(M.prompt)}
              placeholder={t(M.prompt)}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              data-image-task-bar="fill"
              disabled={busy}
              onClick={() => {
                // As the command does: no prompt raises the Image panel.
                if (prompt.trim() === "") void host.shell.openPanel(panelId);
                else void ml().generativeFill(prompt);
              }}
            >
              {t(M.fill)}
            </button>
            <button
              type="button"
              data-image-task-bar="remove"
              disabled={busy}
              onClick={() => void ml().removeSelection()}
            >
              {t(M.remove)}
            </button>
            <button
              type="button"
              data-image-task-bar="subject"
              disabled={busy}
              onClick={() => void ml().selectSubject()}
            >
              {t(M.subject)}
            </button>
          </div>
        </foreignObject>
      </g>
    );
  }
  return TaskBar;
}
