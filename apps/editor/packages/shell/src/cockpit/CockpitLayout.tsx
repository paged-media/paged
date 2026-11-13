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

// Cockpit — the publishing-cockpit layout (kit app.jsx / canvas.jsx).
// Replaces the dockview body area with three columns: LeftPanel (the
// mode's single left panel) · CanvasColumn (title bar · rulers · viewport
// on the canvas surround · thumbnail filmstrip) · RightDock (tab group).
// The ToolRail / PanelRail / ModeSwitcher stay PagedShell chrome around
// this component.
//
// Mode slots resolve through the mode registry; panel ids resolve
// through the panel registry (PanelHost) — the same contracts
// plugins use, so a custom panel renders here untouched.
//
// The docks are resizable and the workspace adapts (editor ADR "Docks are
// resizable and the workspace adapts"; UX audit F-55): each dock has a
// divider (DockSplitter, 240–480 px, double-click restores the default),
// its width is remembered per workflow mode, and the layout follows the
// width this element is given (workspace-class.ts) — wide: both docks
// docked; laptop: the left dock collapses to a rail that opens it as a
// flyout (pin it to dock it again); narrow: both docks are overlays that
// the next canvas interaction closes. A docked column never pushes the
// canvas below its working minimum (dock-sizing.ts). The camera keeps the
// document point at the viewport's centre as the canvas resizes
// (UXI-CAM-003, camera-context.tsx).
//
// What is hidden stays mounted (ADR 240): Tab / Shift+Tab hides the side
// columns in an <Activity>, the left panel of every mode visited so far
// stays mounted beside the current one, and an export-style mode hides
// the document viewport instead of unmounting it. A hidden subtree keeps
// its state and DOM and has its effects unmounted, so it holds no
// subscription while hidden; showing it again does not mount it again
// (the viewport keeps its transferred canvas and its camera). A column
// that turns from docked into a flyout or a drawer is the same element,
// restyled, so its panel is not mounted again either.

import { useStrings } from "@paged-media/strings";
import { COCKPIT } from "./messages";
import {
  Activity,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";

import { canvasViewportSurfaceProps } from "../focus/canvas-surface";
import type { PanelProps } from "../registries/panel";
import { usePaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useWorkflowMode } from "../state/workflow-mode-context";
import { useChromeRegions } from "../state/chrome-regions";
import { useEditorScope } from "../state/editor-scope";
import {
  TOUCH_TARGET_PX,
  useCompactLayout,
  useTouchSized,
} from "../state/compact";
import type { ResolvedRegion } from "../profile/types";
import { Icon, hasIcon } from "../icons";
import { PluginGlyph } from "../icons/plugin-glyph";
import { PanelHost } from "./PanelHost";
import { CanvasDropZone } from "./drop-zone";
import { TouchZoomControls } from "./TouchZoom";
import { RightDock } from "./RightDock";
import { ModuleViewHost } from "./ModuleViewHost";
import { PresentationChrome } from "./PresentationChrome";
import { StatusBar } from "../chrome/ContributedBarItems";
import { DocTitleBar } from "./canvas-frame/DocTitleBar";
import { GuideDragController } from "./canvas-frame/GuideDragController";
import { HRuler, VRulerStrip } from "./canvas-frame/Rulers";
import { ThreadingController } from "./canvas-frame/ThreadingController";
import { ThumbnailRail } from "./canvas-frame/ThumbnailRail";
import { CanvasLoadingStatus } from "./canvas-frame/LoadingStatus";
import { useOptionalDocument } from "../state/document-context";
import { useOptionalCockpitState } from "./cockpit-state-context";
import {
  loadDockStore,
  saveModeDockState,
  type DockStore,
} from "./cockpit-persistence";
import {
  DOCK_MAX_PX,
  fitDocks,
  maxDockWidth,
  maxOverlayWidth,
  resolvedDockWidths,
  type DockId,
} from "./dock-sizing";
import { DockSplitter } from "./DockSplitter";
import {
  useAdaptiveWorkspace,
  useRightDrawer,
  useWorkspaceClassStore,
  workspaceClassOf,
} from "./workspace-class";
import { focusWorkspaceStrings, setFocusWorkspace } from "./focus-workspace";
import { useFocusWorkspace } from "./focus-workspace";

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

/** The width of the rail a collapsed left dock leaves (CSS px). */
const DOCK_RAIL_PX = 40;

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
  const scope = useEditorScope();
  const chrome = useChromeRegions();
  const features = useRegistryView(useRegistries().features);
  // The Focus workspace (focus-workspace.ts) hides everything but the
  // canvas and the tool rail; leaving it restores this layout as it was.
  const focus = useFocusWorkspace();
  const hidden = Boolean(panelsHidden) || focus;
  // Canvas furniture: the profile's (absent, never rendered) and the
  // features' (switched at runtime), both must allow it.
  const titleBar =
    chrome.canvas.titleBar && features.allows("chrome", "title-bar") && !focus;
  const rulers = chrome.canvas.rulers && features.allows("chrome", "rulers");
  const thumbnails =
    chrome.canvas.thumbnails && features.allows("chrome", "thumbnails");
  const modes = useRegistryView(useRegistries().modes);
  const panels = useRegistryView(useRegistries().panels);
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
  // Editor ADR 306 — a module view (a slide sorter) takes the canvas's
  // place the same way, and wins over the mode's panel while shown.
  const views = useRegistryView(useRegistries().views);
  const activeViewId = views.active();
  const moduleView = activeViewId ? views.get(activeViewId) : undefined;
  // Export-style modes replace the document viewport with a centred
  // work surface — no rulers / filmstrip around it (kit canvas.jsx).
  const isOverride = canvasOverride != null || moduleView !== undefined;

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

  // ── The work area: measured on this element, never the window ──────
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [workArea, setWorkArea] = useState(0);
  useEffect(() => {
    if (!root) return;
    const measure = () => setWorkArea(root.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);
  // Off (Edit ▸ Settings), the fixed layout at every width.
  const adaptive = useAdaptiveWorkspace();
  const workspace = adaptive ? workspaceClassOf(workArea) : "wide";
  const classStore = useWorkspaceClassStore();
  useEffect(() => {
    classStore.set(workspace);
  }, [classStore, workspace]);

  // ── The docks' widths, per workflow mode ───────────────────────────
  const [dockStore, setDockStore] = useState<DockStore>(() =>
    loadDockStore(scope),
  );
  const modeDocks = dockStore[mode] ?? {};
  const chosen = resolvedDockWidths(modeDocks);
  const remember = (
    patch: Partial<Record<DockId, number>> & {
      leftPinned?: boolean;
    },
  ) => {
    setDockStore(
      saveModeDockState(scope, dockStore, mode, { ...modeDocks, ...patch }),
    );
  };

  // ── Docked, flyout or drawer ───────────────────────────────────────
  // The left column stays mounted while the profile has one, even in a
  // mode without a left panel (its visited panels keep their state).
  const leftColumn = chrome.has("left");
  const hasLeft = leftColumn && Boolean(leftId);
  const hasRight = chrome.has("right");
  const pinned = modeDocks.leftPinned === true;
  const leftFlyout =
    workspace === "narrow" || (workspace === "laptop" && !pinned);
  const rightDrawer = workspace === "narrow";
  // The open flyout is the panel it was opened for: a mode switch (a
  // different left panel) closes it.
  const [flyoutFor, setFlyoutFor] = useState<string | null>(null);
  const flyoutOpen = leftFlyout && flyoutFor !== null && flyoutFor === leftId;
  const [drawerOpen, setDrawerOpen] = useRightDrawer();
  // A panel opened from anywhere (the Window menu, the palette, a command)
  // while the dock is a drawer opens the drawer; closing a tab opens
  // nothing. (The panel rail opens it itself, PagedShell.)
  const cockpit = useOptionalCockpitState();
  const activeTab = cockpit?.activeTab ?? null;
  const tabCount = cockpit?.rightTabs.length ?? 0;
  const seenTabs = useRef({ active: activeTab, count: tabCount, mode });
  useEffect(() => {
    const seen = seenTabs.current;
    seenTabs.current = { active: activeTab, count: tabCount, mode };
    // A mode switch brings its own tabs: that is no panel being opened.
    if (
      rightDrawer &&
      mode === seen.mode &&
      activeTab !== null &&
      activeTab !== seen.active &&
      tabCount >= seen.count
    ) {
      setDrawerOpen(true);
    }
  }, [activeTab, tabCount, mode, rightDrawer, setDrawerOpen]);
  const closeOverlays = () => {
    if (flyoutFor !== null) setFlyoutFor(null);
    if (drawerOpen) setDrawerOpen(false);
  };

  const leftShown = hasLeft && !hidden && (!leftFlyout || flyoutOpen);
  const leftRail = hasLeft && !hidden && workspace !== "wide";
  const rightShown =
    hasRight && !hidden && !sheet && (!rightDrawer || drawerOpen);
  // Without the panel rail (a profile that drops it) a drawer needs a
  // button of its own.
  const rightRail =
    hasRight && !hidden && !sheet && rightDrawer && !chrome.has("panel-rail");
  const formDocked = formId !== null && !sheet;

  // What the docked columns get: what was chosen, given way so the canvas
  // keeps its working minimum. Overlays take no width from the canvas.
  const area =
    workArea - (leftRail ? DOCK_RAIL_PX : 0) - (rightRail ? DOCK_RAIL_PX : 0);
  const wanted = {
    ...(leftShown && !leftFlyout ? { left: chosen.left } : null),
    ...(rightShown && !rightDrawer ? { right: chosen.right } : null),
    ...(formDocked ? { form: chosen.form } : null),
  };
  const fitted = adaptive ? fitDocks(area, wanted) : wanted;
  const overlayMax = maxOverlayWidth(area);
  const leftWidth = leftFlyout
    ? Math.min(chosen.left, overlayMax)
    : (fitted.left ?? chosen.left);
  const rightWidth = rightDrawer
    ? Math.min(chosen.right, overlayMax)
    : (fitted.right ?? chosen.right);
  const formWidth = fitted.form ?? chosen.form;
  const docked = (except: DockId) =>
    (except !== "left" ? (fitted.left ?? 0) : 0) +
    (except !== "right" ? (fitted.right ?? 0) : 0) +
    (except !== "form" ? (fitted.form ?? 0) : 0);
  const maxFor = (dock: DockId, overlay: boolean) =>
    overlay
      ? overlayMax
      : adaptive
        ? maxDockWidth(area, docked(dock))
        : DOCK_MAX_PX;

  const ids = useId();
  const leftDomId = `${ids}-left-dock`;
  const rightDomId = `${ids}-right-dock`;
  const formDomId = `${ids}-form-column`;
  const doc = useOptionalDocument();
  const loadingStage = doc?.loading
    ? (doc.loading.stage ?? "recognized")
    : doc?.handle
      ? "ready"
      : undefined;
  const leftPanel = leftId ? panels.get(leftId) : undefined;
  const leftTitle = leftPanel?.title ?? strings.t(COCKPIT.leftPanels);
  const focusWords = focusWorkspaceStrings();

  const main = (
    <main
      data-cockpit-main
      aria-label={strings.t(COCKPIT.document)}
      // The next canvas interaction closes a flyout or a drawer (the
      // press itself still reaches the canvas).
      onPointerDownCapture={closeOverlays}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--pg-bg)",
        position: "relative",
      }}
    >
      {/* Editor ADR 304 — a presentation hides the chrome. */}
      <PresentationChrome />
      {titleBar && <DocTitleBar />}
      {!isOverride && rulers && <HRuler />}
      {/* The drop target (drop-zone.tsx): a Data panel field, table or
          record is placed on the document (editor ADR 291), a file goes
          to `onFile`. */}
      <CanvasDropZone
        acceptsDataDrops={!isOverride}
        onFile={onFile}
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
          // UXI-PRF-003 — the load's stage, "ready" once it is done.
          data-loading-stage={loadingStage}
          // ADR 234 — the document canvas is a keyboard surface: Tab
          // reaches it, and a click in it makes Tab the chrome toggle.
          {...(isOverride ? null : canvasViewportSurfaceProps)}
          style={{ flex: 1, minWidth: 0, position: "relative" }}
        >
          <Activity mode={isOverride ? "hidden" : "visible"} name="canvas">
            <CanvasComponent paged={paged} api={{ id: "paged.canvas" }} />
          </Activity>
          {/* Progressive loading (F-53): the stage and, until the first
              page is composed, the pages' outlines. */}
          {!isOverride && <CanvasLoadingStatus />}
          {moduleView ? (
            <ModuleViewHost view={moduleView} />
          ) : (
            canvasOverride != null && <PanelHost id={canvasOverride} />
          )}
        </div>
        {!isOverride && touch && <TouchZoomControls />}
        {focus && (
          <button
            type="button"
            data-focus-exit
            title={focusWords.exit}
            aria-label={focusWords.exit}
            onClick={() => setFocusWorkspace(scope, false)}
            style={focusExitStyle}
          >
            <Icon name="ui-x" size={14} />
            {focusWords.exit}
          </button>
        )}
      </CanvasDropZone>
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
      {!isOverride && thumbnails && !sheet && !focus && <ThumbnailRail />}
      {/* Editor ADR 298 — the status items of the active context (a Word
          document's page and word counts); absent when none apply. */}
      {!isOverride && !focus && <StatusBar />}
    </main>
  );

  if (formFirst) {
    return (
      <div
        ref={setRoot}
        data-cockpit-layout
        data-compact-layout="form-first"
        data-workspace-class={workspace}
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
  // after it for one that fills on the canvas. Hidden with the docks in
  // the Focus workspace.
  const formBefore = chrome.compact === "form-first";
  const formSplitter =
    formDocked && !focus ? (
      <DockSplitter
        dock="form"
        side={formBefore ? "start" : "end"}
        width={formWidth}
        max={maxFor("form", false)}
        label={strings.t(COCKPIT.resizeFields)}
        controls={formDomId}
        onResize={(px) => remember({ form: px })}
      />
    ) : null;
  const formColumn = formDocked ? (
    <Activity mode={focus ? "hidden" : "visible"} name="form column">
      <div
        id={formDomId}
        data-form-column
        role="complementary"
        aria-label={strings.t(COCKPIT.fields)}
        style={{
          width: formWidth,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "auto",
          ...(formBefore
            ? { borderRight: "1px solid var(--chrome-border)" }
            : { borderLeft: "1px solid var(--chrome-border)" }),
          background: "var(--pg-bg)",
        }}
      >
        <PanelHost id={formId} />
      </div>
    </Activity>
  ) : null;

  return (
    <div
      ref={setRoot}
      data-cockpit-layout
      data-compact-layout={compact ?? undefined}
      data-workspace-class={workspace}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        position: "relative",
      }}
    >
      {formBefore && formColumn}
      {formBefore && formSplitter}
      {leftRail && (
        <nav
          data-dock-rail="left"
          aria-label={strings.t(COCKPIT.leftPanels)}
          style={railStyle}
        >
          <button
            type="button"
            data-dock-rail-toggle="left"
            aria-expanded={leftShown}
            aria-controls={leftDomId}
            title={leftTitle}
            aria-label={leftTitle}
            onClick={() => {
              // Pinned open: the button collapses it to the rail again.
              if (!leftFlyout) remember({ leftPinned: false });
              else setFlyoutFor(flyoutOpen ? null : (leftId ?? null));
            }}
            style={railButtonStyle(leftShown)}
          >
            {leftPanel?.icon && hasIcon(leftPanel.icon) ? (
              <Icon name={leftPanel.icon} size={17} />
            ) : leftPanel?.iconSvg ? (
              <PluginGlyph svg={leftPanel.iconSvg} size={17} />
            ) : (
              <Icon name="ui-cols-2" size={17} />
            )}
          </button>
          {workspace === "laptop" && (
            <button
              type="button"
              data-dock-pin="left"
              aria-pressed={pinned}
              title={strings.t(pinned ? COCKPIT.unpinPanel : COCKPIT.pinPanel)}
              aria-label={strings.t(
                pinned ? COCKPIT.unpinPanel : COCKPIT.pinPanel,
              )}
              onClick={() => {
                remember({ leftPinned: !pinned });
                setFlyoutFor(null);
              }}
              style={railButtonStyle(pinned)}
            >
              <Icon name="ui-pin" size={15} />
            </button>
          )}
        </nav>
      )}
      {leftColumn && (
        <Activity mode={leftShown ? "visible" : "hidden"} name="left column">
          <div
            id={leftDomId}
            data-left-panel={leftId}
            data-dock-presentation={leftFlyout ? "flyout" : "docked"}
            // F-50 (ADR 259): the docks are complementary landmarks.
            role="complementary"
            aria-label={strings.t(COCKPIT.leftPanels)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && leftFlyout && !e.defaultPrevented) {
                setFlyoutFor(null);
              }
            }}
            style={{
              width: leftWidth,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRight: "1px solid var(--chrome-border)",
              background: "var(--pg-bg)",
              overflow: "hidden",
              ...(leftFlyout
                ? {
                    ...overlayStyle,
                    left: leftRail ? DOCK_RAIL_PX : 0,
                  }
                : null),
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
      {leftShown && (
        <div
          style={
            leftFlyout
              ? {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: (leftRail ? DOCK_RAIL_PX : 0) + leftWidth,
                  zIndex: 41,
                  display: "flex",
                }
              : { display: "flex" }
          }
        >
          <DockSplitter
            dock="left"
            side="start"
            width={leftWidth}
            max={maxFor("left", leftFlyout)}
            label={strings.t(COCKPIT.resizeLeft)}
            controls={leftDomId}
            onResize={(px) => remember({ left: px })}
          />
        </div>
      )}

      {/* Canvas column — the main landmark (F-50, ADR 259). */}
      {main}

      {!formBefore && formSplitter}
      {!formBefore && formColumn}

      {rightShown && (
        <div
          style={
            rightDrawer
              ? {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  right: rightWidth + (rightRail ? DOCK_RAIL_PX : 0),
                  zIndex: 41,
                  display: "flex",
                }
              : { display: "flex" }
          }
        >
          <DockSplitter
            dock="right"
            side="end"
            width={rightWidth}
            max={maxFor("right", rightDrawer)}
            label={strings.t(COCKPIT.resizePanels)}
            controls={rightDomId}
            onResize={(px) => remember({ right: px })}
          />
        </div>
      )}
      {hasRight && (
        <Activity mode={rightShown ? "visible" : "hidden"} name="right column">
          <div
            id={rightDomId}
            data-right-column
            data-dock-presentation={rightDrawer ? "drawer" : "docked"}
            role="complementary"
            aria-label={strings.t(COCKPIT.panels)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && rightDrawer && !e.defaultPrevented) {
                setDrawerOpen(false);
              }
            }}
            style={{
              width: rightWidth,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderLeft: "1px solid var(--chrome-border)",
              background: "var(--pg-bg)",
              overflow: "hidden",
              ...(rightDrawer
                ? { ...overlayStyle, right: rightRail ? DOCK_RAIL_PX : 0 }
                : null),
            }}
          >
            <RightDock />
          </div>
        </Activity>
      )}
      {rightRail && (
        <nav
          data-dock-rail="right"
          aria-label={strings.t(COCKPIT.panels)}
          style={{
            ...railStyle,
            borderRight: "none",
            borderLeft: "1px solid var(--chrome-border)",
          }}
        >
          <button
            type="button"
            data-dock-rail-toggle="right"
            aria-expanded={drawerOpen}
            aria-controls={rightDomId}
            title={strings.t(COCKPIT.panels)}
            aria-label={strings.t(COCKPIT.panels)}
            onClick={() => setDrawerOpen(!drawerOpen)}
            style={railButtonStyle(drawerOpen)}
          >
            <Icon name="ui-cols-2" size={17} />
          </button>
        </nav>
      )}
    </div>
  );
}

/** A flyout or a drawer: over the canvas, the full height of the work
 *  area, lifted by a shadow. */
const overlayStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  zIndex: 40,
  boxShadow: "var(--shadow-pop)",
};

const railStyle: CSSProperties = {
  width: DOCK_RAIL_PX,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  paddingTop: 6,
  borderRight: "1px solid var(--chrome-border)",
  background: "var(--chrome-panel-bg)",
};

function railButtonStyle(active: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    border: "none",
    padding: 0,
    cursor: "pointer",
    background: active ? "var(--selected-bg)" : "transparent",
    color: active ? "var(--pg-primary)" : "var(--chrome-icon)",
  };
}

const focusExitStyle: CSSProperties = {
  position: "absolute",
  top: 10,
  right: 12,
  zIndex: 30,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 10px",
  borderRadius: "var(--radius-full)",
  border: "1px solid var(--pg-border)",
  background: "var(--elevated)",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  cursor: "pointer",
  boxShadow: "var(--shadow-2)",
};
