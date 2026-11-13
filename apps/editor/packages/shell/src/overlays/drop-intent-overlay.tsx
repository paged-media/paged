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

// The drop's ghost label (editor ADR 1205; UXI-DND-002; UX audit F-40):
// while a file is dragged over the canvas, a label beside the pointer says
// what releasing it will do ("Place photo.png in this frame", "Open
// Annual.idml in place of this document"), the frame that would take a
// picture is outlined, and a refused drop says why under a not-allowed
// cursor. The drop zone writes the state (`dropIntentDrag`); this renders
// it, in the editor's portal container, above the canvas.

import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";

import {
  createValueStore,
  scoped,
  useEditorScope,
  type EditorScope,
  type ValueStore,
} from "../state/editor-scope";
import type { DropIntent } from "../state/drop-intent";
import { usePortalContainer } from "../state/editor-root";

/** A drag over the canvas: what releasing will do, and where the pointer
 *  and the target frame are on screen. */
export interface DropIntentDrag {
  readonly intent: DropIntent;
  readonly clientX: number;
  readonly clientY: number;
  /** The frame that would take the picture, in client pixels. */
  readonly frame: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

const DRAG = scoped("dropIntentDrag", () =>
  createValueStore<DropIntentDrag | null>(null),
);

/** `scope`'s drag-over state: the drop zone sets it, null when the drag
 *  leaves or drops. */
export function dropIntentDrag(
  scope: EditorScope,
): ValueStore<DropIntentDrag | null> {
  return scope.get(DRAG);
}

const OFFSET = 16;

export function DropIntentOverlay() {
  const store = dropIntentDrag(useEditorScope());
  const drag = useSyncExternalStore(store.subscribe, store.get, store.get);
  const container = usePortalContainer();
  if (!drag) return null;
  const { intent } = drag;
  const refused = intent.intent === "reject";
  const body = (
    <>
      {drag.frame && !refused && (
        <div
          aria-hidden
          data-drop-target-frame
          style={{
            position: "fixed",
            left: drag.frame.left,
            top: drag.frame.top,
            width: drag.frame.width,
            height: drag.frame.height,
            outline: "2px solid var(--overlay-selection, var(--pg-primary))",
            outlineOffset: 1,
            pointerEvents: "none",
            zIndex: 60,
          }}
        />
      )}
      <div
        role="status"
        aria-live="polite"
        data-drop-intent={intent.intent}
        data-drop-provisional={intent.provisional ? "" : undefined}
        style={{
          position: "fixed",
          left: drag.clientX + OFFSET,
          top: drag.clientY + OFFSET,
          maxWidth: 320,
          padding: "5px 9px",
          borderRadius: "var(--radius-md)",
          border: `1px solid ${refused ? "var(--status-error)" : "var(--chrome-divider)"}`,
          background: "var(--elevated)",
          boxShadow: "var(--shadow-pop)",
          color: "var(--chrome-menu-text)",
          fontSize: 12,
          lineHeight: 1.4,
          pointerEvents: "none",
          zIndex: 61,
        }}
      >
        <div data-drop-label style={{ fontWeight: 600 }}>
          {intent.label}
        </div>
        {intent.reason && (
          <div
            data-drop-reason
            style={{ color: "var(--pg-muted-fg)", marginTop: 2 }}
          >
            {intent.reason}
          </div>
        )}
      </div>
    </>
  );
  return container ? createPortal(body, container) : body;
}
