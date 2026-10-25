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

// Cockpit — the fixed publishing-cockpit layout (kit app.jsx /
// canvas.jsx). Replaces the dockview body area with three fixed
// columns: LeftPanel (262px, the mode's single left panel) ·
// CanvasColumn (title bar · rulers · viewport on the canvas
// surround · thumbnail filmstrip) · RightDock (320px tab group).
// The ToolRail / PanelRail / ModeSwitcher stay PagedShell chrome
// around this component.
//
// Mode slots resolve through the mode registry; panel ids resolve
// through the panel registry (PanelHost) — the same contracts
// plugins use, so a custom panel renders here untouched.
//
// What is hidden stays mounted (ADR 240): Tab / Shift+Tab hides the side
// columns in an <Activity>, the left panel of every mode visited so far
// stays mounted beside the current one, and an export-style mode hides
// the document viewport instead of unmounting it. A hidden subtree keeps
// its state and DOM and has its effects unmounted, so it holds no
// subscription while hidden; showing it again does not mount it again
// (the viewport keeps its transferred canvas and its camera).

import { useStrings } from "@paged-media/strings";
import { COCKPIT } from "./messages";
import { Activity, useState, type ComponentType } from "react";

import { canvasViewportSurfaceProps } from "../focus/canvas-surface";
import type { PanelProps } from "../registries/panel";
import { usePaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useWorkflowMode } from "../state/workflow-mode-context";
import { useChromeRegions } from "../state/chrome-regions";
import { useDataDrop } from "../state/data-door";
import {
  TOUCH_TARGET_PX,
  useCompactLayout,
  useTouchSized,
} from "../state/compact";
import type { ResolvedRegion } from "../profile/types";
import { Icon } from "../icons";
import { PanelHost } from "./PanelHost";
import { TouchZoomControls } from "./TouchZoom";
import { RightDock } from "./RightDock";
import { StatusBar } from "../chrome/ContributedBarItems";
import { DocTitleBar } from "./canvas-frame/DocTitleBar";
import { GuideDragController } from "./canvas-frame/GuideDragController";
import { HRuler, VRulerStrip } from "./canvas-frame/Rulers";
import { ThreadingController } from "./canvas-frame/ThreadingController";
import { ThumbnailRail } from "./canvas-frame/ThumbnailRail";

export interface CockpitLayoutProps {
  /** The document viewport (apps/canvas's CanvasPanel) — rendered in
   *  the canvas column unless the mode overrides the canvas slot. */
  canvasComponent: ComponentType<PanelProps>;
  /** Tab / Shift+Tab chrome hiding — when true the side panels
   *  disappear and the canvas column fills the row. */
  panelsHidden?: boolean;
  /** IDML intake — the canvas column is the drag-drop target. `at` is
   *  where the file was dropped (a picture is placed there, F-03). */
  onFile?: (file: File, at?: { clientX: number; clientY: number }) => void;
}

/** The template form, unless the form region names another panel. */
const DEFAULT_FORM_PANEL = "paged.template.form";

/** The panel the form region shows: its first id. */
function formPanelOf(region: ResolvedRegion | null): string | null {
  if (!region) return null;
  const items = region.kind === "list" ? region.items : region.append;
  const first = items.find((item) => typeof item === "string");
  return typeof first === "string" ? first : DEFAULT_FORM_PANEL;
}

export function CockpitLayout({
  canvasComponent: CanvasComponent,
  panelsHidden,
  onFile,
}: CockpitLayoutProps) {
  const strings = useStrings();
  const paged = usePaged();
  const chrome = useChromeRegions();
  const features = useRegistryView(useRegistries().features);
  // Canvas furniture: the profile's (absent, never rendered) and the
  // features' (switched at runtime), both must allow it.
  const titleBar =
    chrome.canvas.titleBar && features.allows("chrome", "title-bar");
  const rulers = chrome.canvas.rulers && features.allows("chrome", "rulers");
  const thumbnails =
    chrome.canvas.thumbnails && features.allows("chrome", "thumbnails");
  const modes = useRegistryView(useRegistries().modes);
  const { mode } = useWorkflowMode();
  const slots = modes.get(mode)?.slots;

  const leftId = slots?.left;
  // The left panels of the modes visited so far, the current one included
  // (state adjusted during render: the list is ready in the same render
  // as the mode).
  const [visitedLeft, setVisitedLeft] = useState<readonly string[]>(() =>
    leftId ? [leftId] : [],
  );
  if (leftId && !visitedLeft.includes(leftId)) {
    setVisitedLeft([...visitedLeft, leftId]);
  }
  const canvasOverride = slots?.canvas?.startsWith("panel:")
    ? slots.canvas.slice("panel:".length)
    : undefined;
  // Export-style modes replace the document viewport with a centred
  // work surface — no rulers / filmstrip around it (kit canvas.jsx).
  const isOverride = canvasOverride != null;
  // Editor ADR 291: a Data panel field, table or record dropped on the
  // document is placed.
  const fieldDrop = useDataDrop();

  // The fill shapes (editor ADR 294). The form region is a column beside
  // the canvas; below the breakpoint `form-first` puts the form first and
  // folds the preview away, and `field-sheet` keeps the canvas and shows
  // the form as a sheet under it (the form panel then shows the active
  // field). On a touch screen the canvas carries zoom buttons.
  const formId = formPanelOf(chrome.region("form"));
  const compact = useCompactLayout();
  const touch = useTouchSized();
  const [previewOpen, setPreviewOpen] = useState(false);
  const sheet = compact === "field-sheet";
  const formFirst = compact === "form-first" && formId !== null;

  const main = (
    <main
      data-cockpit-main
      aria-label={strings.t(COCKPIT.document)}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--pg-bg)",
      }}
    >
      {titleBar && <DocTitleBar />}
      {!isOverride && rulers && <HRuler />}
      <div
        data-cockpit-canvas
        onDragOver={(e) => {
          if (!isOverride && fieldDrop.accepts([...e.dataTransfer.types])) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          } else if (onFile) e.preventDefault();
        }}
        onDrop={(e) => {
          if (
            !isOverride &&
            fieldDrop.accepts([...e.dataTransfer.types]) &&
            fieldDrop.drop(
              (type) => e.dataTransfer.getData(type),
              [...e.dataTransfer.types],
              { clientX: e.clientX, clientY: e.clientY },
            )
          ) {
            e.preventDefault();
            return;
          }
          if (!onFile) return;
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) onFile(file, { clientX: e.clientX, clientY: e.clientY });
        }}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          background: isOverride ? "var(--pg-bg)" : "var(--canvas-surround)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {!isOverride && rulers && <VRulerStrip />}
        {/* W2.8 — `data-paged-viewport` tags the viewport wrapper so
            the GuideDragController can invert client → document
            coordinates against the same rect the canvas uses. */}
        <div
          data-paged-viewport
          // ADR 234 — the document canvas is a keyboard surface: Tab
          // reaches it, and a click in it makes Tab the chrome toggle.
          {...(isOverride ? null : canvasViewportSurfaceProps)}
          style={{ flex: 1, minWidth: 0, position: "relative" }}
        >
          <Activity mode={isOverride ? "hidden" : "visible"} name="canvas">
            <CanvasComponent paged={paged} api={{ id: "paged.canvas" }} />
          </Activity>
          {isOverride && <PanelHost id={canvasOverride} />}
        </div>
        {!isOverride && touch && <TouchZoomControls />}
      </div>
      {/* W2.8 — headless guide-drag controller (ruler → drag →
          insert/move/delete guide). Only on the real canvas surface,
          not the export-style overrides (which have no rulers). */}
      {!isOverride && <GuideDragController />}
      {/* W2.9 — headless threading controller (out-port → loaded
          cursor → linkFrames / insertTextFrame; overset badge set). */}
      {!isOverride && <ThreadingController />}
      {sheet && formId !== null && (
        <section
          data-field-sheet
          aria-label={strings.t(COCKPIT.fields)}
          style={{
            flexShrink: 0,
            maxHeight: "55%",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "auto",
            borderTop: "1px solid var(--chrome-border)",
            borderRadius: "var(--radius-lg) var(--radius-lg) 0 0",
            background: "var(--chrome-panel-bg)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          <PanelHost id={formId} />
        </section>
      )}
      {!isOverride && thumbnails && !sheet && <ThumbnailRail />}
      {/* Editor ADR 298 — the status items of the active context (a Word
          document's page and word counts); absent when none apply. */}
      {!isOverride && <StatusBar />}
    </main>
  );

  if (formFirst) {
    return (
      <div
        data-cockpit-layout
        data-compact-layout="form-first"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <button
          type="button"
          data-preview-toggle
          aria-expanded={previewOpen}
          onClick={() => setPreviewOpen((open) => !open)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minHeight: TOUCH_TARGET_PX,
            padding: "0 var(--space-4)",
            border: "none",
            borderBottom: "1px solid var(--chrome-border)",
            background: "var(--chrome-panel-bg)",
            color: "var(--pg-fg)",
            font: "inherit",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <Icon name={previewOpen ? "ui-eye-off" : "ui-eye"} size={18} />
          {strings.t(previewOpen ? COCKPIT.hidePreview : COCKPIT.showPreview)}
        </button>
        <Activity mode={previewOpen ? "visible" : "hidden"} name="preview">
          <div
            data-preview-pane
            style={{
              flex: "0 0 45%",
              minHeight: 0,
              display: "flex",
              borderBottom: "1px solid var(--chrome-border)",
            }}
          >
            {main}
          </div>
        </Activity>
        <div
          data-form-column
          role="complementary"
          aria-label={strings.t(COCKPIT.fields)}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            background: "var(--pg-bg)",
          }}
        >
          <PanelHost id={formId} />
        </div>
      </div>
    );
  }

  // The form as a column: before the canvas for a form-first shape,
  // after it for one that fills on the canvas.
  const formColumn =
    formId !== null && !sheet ? (
      <div
        data-form-column
        role="complementary"
        aria-label={strings.t(COCKPIT.fields)}
        style={{
          width: 340,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "auto",
          ...(chrome.compact === "form-first"
            ? { borderRight: "1px solid var(--chrome-border)" }
            : { borderLeft: "1px solid var(--chrome-border)" }),
          background: "var(--pg-bg)",
        }}
      >
        <PanelHost id={formId} />
      </div>
    ) : null;

  return (
    <div
      data-cockpit-layout
      data-compact-layout={compact ?? undefined}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
      }}
    >
      {chrome.compact === "form-first" && formColumn}
      {chrome.has("left") && (
        <Activity
          mode={!panelsHidden && leftId ? "visible" : "hidden"}
          name="left column"
        >
          <div
            data-left-panel={leftId}
            // F-50 (ADR 259): the docks are complementary landmarks.
            role="complementary"
            aria-label={strings.t(COCKPIT.leftPanels)}
            style={{
              width: 262,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRight: "1px solid var(--chrome-border)",
              background: "var(--pg-bg)",
              overflow: "hidden",
            }}
          >
            {visitedLeft.map((id) => (
              <Activity
                key={id}
                mode={id === leftId ? "visible" : "hidden"}
                name={id}
              >
                <PanelHost id={id} />
              </Activity>
            ))}
          </div>
        </Activity>
      )}

      {/* Canvas column — the main landmark (F-50, ADR 259). */}
      {main}

      {chrome.compact !== "form-first" && formColumn}

      {chrome.has("right") && (
        <Activity
          mode={panelsHidden || sheet ? "hidden" : "visible"}
          name="right column"
        >
          <div
            role="complementary"
            aria-label={strings.t(COCKPIT.panels)}
            style={{
              width: 320,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderLeft: "1px solid var(--chrome-border)",
              background: "var(--pg-bg)",
              overflow: "hidden",
            }}
          >
            <RightDock />
          </div>
        </Activity>
      )}
    </div>
  );
}
