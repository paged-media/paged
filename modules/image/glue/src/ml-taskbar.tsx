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

// The CONTEXTUAL TASK BAR (WP8.2, image ADR 486): while the image's edit
// context is open on its frame and the image has a selection, a small bar
// sits under it on the canvas with Generative Fill (and its prompt), Remove
// and Select Subject. The buttons call the same ML controller the commands
// of the same names call, so the model, the undo step and the refusal text
// are the commands' own. It draws in document space inside the overlay's
// camera group, but at screen size: pan and zoom move it, they do not scale
// it. With no selection, no image or the context left it renders nothing:
// the session keeps the image and its selection after the context closes
// (the panel and scripts still read them), but the bar is the context's,
// and a bar left on the page took the next frame drag and every key.

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
  type ReactElement,
} from "react";
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

/** The focusable element the bar is drawn on: the canvas the host's
 *  overlay layer sits in (the nearest HTML ancestor in the tab order). */
function surfaceOf(bar: Element): HTMLElement | null {
  for (let n = bar.parentElement; n; n = n.parentElement) {
    if (n instanceof HTMLElement && n.tabIndex >= 0) return n;
  }
  return null;
}

/** Focus inside the bar goes back to the canvas it is drawn on: never to
 *  the page, where the next key belongs to nobody (editor ADR 1206). */
function handBackFocus(bar: Element): void {
  const surface = surfaceOf(bar);
  if (surface) surface.focus({ preventScroll: true });
  else (bar.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
}

/** The bar's root ref: when the bar goes (the context left, the selection
 *  cleared) while focus is inside it, the focus goes back to the canvas.
 *  React detaches the ref before it removes the node, so focus is still
 *  there to see. */
function releaseFocusOnRemove(bar: HTMLDivElement | null) {
  if (!bar) return;
  return () => {
    if (bar.contains(bar.ownerDocument.activeElement)) handBackFocus(bar);
  };
}

/** Escape in the prompt is the field's (the escape arbiter defers a
 *  focused field's keys, editor ADR 1207): it leaves the bar for the
 *  canvas, so the next Escape takes the next rung — the context, which
 *  takes the bar with it. Any other key stays the bar's (image ADR 486). */
function onBarKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key === "Escape" && !e.nativeEvent.isComposing) {
    e.preventDefault();
    handBackFocus(e.currentTarget);
  }
  e.stopPropagation();
}

/** The task bar overlay and what it needs to know of the context. */
export interface TaskBarOverlay {
  /** `host.contribute.overlay`'s component. */
  render: ComponentType<OverlayProps>;
  /** The frame the image's edit context is open on, or null once it has
   *  closed: the context's `onEnter` and `onExit` say so. The bar draws
   *  only over that frame's image. */
  setEnteredFrame(elementId: string | null): void;
}

export function makeTaskBarOverlay(
  host: BundleHost,
  session: ImageSession,
  panelId: string,
): TaskBarOverlay {
  let entered: string | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const enteredFrame = () => entered;

  function TaskBar(props: OverlayProps): ReactElement | null {
    const live = useLive(session, onDidChangeOf);
    const frame = useSyncExternalStore(subscribe, enteredFrame, enteredFrame);
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

    if (!source || frame === null || frame !== elementId) return null;
    if (!sel || sel.w <= 0 || sel.h <= 0 || !fit) return null;
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
            ref={releaseFocusOnRemove}
            role="toolbar"
            aria-label={t(M.label)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={onBarKeyDown}
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
  return {
    render: TaskBar,
    setEnteredFrame(elementId) {
      if (entered === elementId) return;
      entered = elementId;
      for (const listener of [...listeners]) listener();
    },
  };
}
