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

// Design system (publishing cockpit) — the context toolbar between the
// header and the body row (`--chrome-toolbar-h`, the density's). The LEFT
// segment is mode-aware (the active ModeContribution's `toolbarLeft`);
// the RIGHT side carries the app's view controls and the Focus workspace
// pill (cockpit/focus-workspace.ts: everything but the canvas and the
// tool rail hides; the same command brings the layout back).

import type { ReactNode } from "react";
import { useStrings } from "@paged-media/strings";

import { Icon, hasIcon } from "../icons";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useOptionalTool } from "../state/tool-context";
import { useWorkflowMode } from "../state/workflow-mode-context";
import {
  useOptionalEditContextStack,
  type EditContextFrame,
} from "../state/edit-context-stack";
import { CONTEXT_TOOLBAR } from "./messages";
import { prettyKey } from "./MenuBar";
import {
  FOCUS_WORKSPACE_COMMAND,
  FOCUS_WORKSPACE_KEYS,
} from "../cockpit/focus-workspace";
import { ContributedControlBarGroups } from "./ContributedBarItems";
import { ToolOptionsInline } from "./ToolOptionsPopover";
import { ContextTrail, useHostsContextTrail } from "./EditContextBreadcrumb";
import { FrameLevelControl } from "./FrameLevelControl";
import { useSelection } from "../state/selection-context";

export interface ContextToolbarProps {
  /** Editor handle threaded into the mode's toolbar segment. */
  paged: unknown;
  /** Constant right-side controls (app-supplied view pills). */
  right?: ReactNode;
}

export function ContextToolbar({ paged, right }: ContextToolbarProps) {
  const strings = useStrings();
  const { mode } = useWorkflowMode();
  const registries = useRegistries();
  const { commands } = registries;
  const modes = useRegistryView(registries.modes);
  const contribution = modes.get(mode);
  const Left = contribution?.toolbarLeft;
  // ADR 024 — the toolbar follows the CONTEXT when there is one.
  //
  // Its left segment is the workflow MODE's, and a mode is a
  // workspace-level choice while a context is a content-level fact —
  // two different axes, of which only one was wired. So editing a
  // spreadsheet kept the host's design-tool pills on the bar directly
  // above the canvas: controls for page items, over content that has
  // none.
  //
  // This does NOT decide the larger question ADR 024 leaves open (may a
  // context CONTRIBUTE toolbar segments?). It needs no new contribution
  // surface at all — the context already declares `toolIds`, and the
  // tool registry already knows their titles. When a context is active
  // the bar states where you are and what applies; otherwise nothing
  // changes.
  const editContexts = useOptionalEditContextStack();
  const active = editContexts?.active ?? null;
  // F-48 (UXI-CTX-008) — the breadcrumb lives in this bar, whose height is
  // fixed, so entering a context or a group moves nothing below it.
  useHostsContextTrail();
  const groupsEntered = useSelection().activeGroupPath.length > 0;

  return (
    <div
      data-context-toolbar
      data-mode={mode}
      data-edit-context={active?.type ?? undefined}
      style={barStyle}
    >
      <div style={leftStyle}>
        {active ? (
          <ContextSegment frame={active} />
        ) : (
          <>
            {groupsEntered && (
              <>
                <ContextTrail />
                <span style={sepStyle} aria-hidden />
              </>
            )}
            {/* Editor ADR 1215 — Frame · Content · Edit for a selected
                frame that has more than one level. */}
            <FrameLevelControl />
            {Left ? (
              <Left paged={paged} />
            ) : (
              <span className="pg-ui-xs" style={{ paddingLeft: 2 }}>
                {contribution?.blurb ?? ""}
              </span>
            )}
          </>
        )}
      </div>
      <div style={rightStyle}>
        {right}
        {/* Overview / Spread / Story were three disabled "coming soon"
            pills here, permanently, on the bar directly above the work.
            They return when the view modes exist. */}
        {right != null && <span style={sepStyle} />}
        <ViewPill
          name="ui-expand"
          title={strings.t(CONTEXT_TOOLBAR.focusWorkspace, {
            key: prettyKey(FOCUS_WORKSPACE_KEYS[0]),
          })}
          onClick={() => void commands.invoke(FOCUS_WORKSPACE_COMMAND)}
        />
      </div>
    </div>
  );
}

/** `rasterImage` → `Raster image` — the breadcrumb's rule. */
function titleCase(type: string): string {
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** What the segment shows for a context: its name, the tools that edit
 *  it, and whether it declared that none do. */
export interface ContextSegmentModel {
  label: string;
  tools: Array<{ id: string; title: string; icon: string }>;
  /** True for a DECLARED list none of whose tools exist (`[]`, or ids
   *  the registry does not know): "no canvas tools apply here". */
  noTools: boolean;
}

export function contextSegmentModel(
  frame: Pick<EditContextFrame, "label" | "type" | "toolIds">,
  lookup: (id: string) => { title: string; icon: string } | undefined,
): ContextSegmentModel {
  const tools = (frame.toolIds ?? []).flatMap((id) => {
    const t = lookup(id);
    return t ? [{ id, title: t.title, icon: t.icon }] : [];
  });
  return {
    // The module's own name (F-45); a label that is only the type reads
    // as words.
    label:
      !frame.label || frame.label === frame.type
        ? titleCase(frame.type)
        : frame.label,
    tools,
    noTools: frame.toolIds !== null && tools.length === 0,
  };
}

/**
 * What the bar shows while a plugin content type is being edited: the
 * content you are in, the TOOL IN HAND — named, not an unlabelled icon —
 * with its options, and the context's own control-bar groups.
 *
 * The tools themselves are picked in the tool rail, which a context
 * restricts to its own tools (image ADR 487, UX audit F-43). The bar used
 * to repeat every one of them as an icon pill as well, so a raster image
 * showed fifteen tools in the rail and about forty in the bar, partly the
 * same: two tool sets. One set is the rail; the bar is where the tool in
 * hand is adjusted.
 *
 * The empty case is a STATEMENT, not a blank. A context declaring
 * `toolIds: []` has said no canvas tool edits its content — a
 * spreadsheet, a web frame, a data binding — and saying so out loud is
 * the point of the declaration.
 */
function ContextSegment({ frame }: { frame: EditContextFrame }) {
  const strings = useStrings();
  const tools = useRegistryView(useRegistries().tools);
  const tool = useOptionalTool();
  const model = contextSegmentModel(frame, (id) => {
    const t = tools.get(id as never);
    return t ? { title: t.title, icon: t.icon } : undefined;
  });
  const inHandId = tool?.toolState.base ?? null;
  const inHand = inHandId ? tools.get(inHandId as never) : undefined;
  // The host's Content level of a picture frame (editor ADR 1215): the
  // picture's placement, which never changes its pixels.
  const placement = frame.type === "paged.imageContent";

  return (
    <span
      className="pg-ui-xs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 2,
        minWidth: 0,
      }}
      data-context-segment
    >
      {/* Where you are: the entered groups and contexts, by the names
          their modules give them; the last one is this context's label
          (`data-context-label`). Its Esc button leaves one level. */}
      <ContextTrail />
      <FrameLevelControl />
      {placement ? (
        <span
          data-context-edit-kind="placement"
          title={strings.t(CONTEXT_TOOLBAR.placementHint)}
          style={chipStyle}
        >
          {strings.t(CONTEXT_TOOLBAR.placement)}
        </span>
      ) : null}
      {model.tools.length > 0 && inHand && inHandId ? (
        <>
          <span style={sepStyle} aria-hidden />
          <span
            data-context-tool-in-hand={inHandId}
            title={strings.t(CONTEXT_TOOLBAR.toolsInRail)}
            aria-label={strings.t(CONTEXT_TOOLBAR.toolInHand, {
              tool: inHand.title,
            })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              whiteSpace: "nowrap",
              color: "var(--pg-primary)",
            }}
          >
            {hasIcon(inHand.icon) ? (
              <Icon name={inHand.icon} size={16} />
            ) : null}
            <span style={{ fontWeight: 600 }}>{inHand.title}</span>
          </span>
          {inHand.options && inHand.options.fields.length > 0 ? (
            <ToolOptionsInline spec={inHand.options} />
          ) : null}
        </>
      ) : null}
      {model.noTools && (
        <span style={{ opacity: 0.7, whiteSpace: "nowrap" }}>
          {strings.t(CONTEXT_TOOLBAR.noTools)}
        </span>
      )}
      {/* Editor ADR 298 — the context's own control-bar groups (Word's
          Home group inside a Word document; the image's edit kind). */}
      <ContributedControlBarGroups editContext={frame.type} />
    </span>
  );
}

const chipStyle: React.CSSProperties = {
  font: "10px var(--font-sans, sans-serif)",
  lineHeight: "14px",
  padding: "0 5px",
  borderRadius: 3,
  border: "1px dashed var(--pg-border)",
  color: "var(--pg-muted-fg)",
  whiteSpace: "nowrap",
};

/** Kit chrome.jsx Pill — 30px icon toggle; active fills the soft
 *  violet, disabled seams render dimmed with an honest tooltip. */
function ViewPill({
  name,
  title,
  active,
  disabled,
  onClick,
}: {
  name: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      data-view-pill={name}
      onClick={onClick}
      style={{
        width: "var(--density-control-h)",
        height: "var(--density-control-h)",
        borderRadius: "var(--radius-md)",
        border: "none",
        background: active ? "var(--selected-bg)" : "transparent",
        color: active ? "var(--pg-primary)" : "var(--chrome-icon)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        padding: 0,
      }}
    >
      {hasIcon(name) ? (
        <Icon
          name={name}
          size={18}
          style={{
            width: "var(--density-icon)",
            height: "var(--density-icon)",
          }}
        />
      ) : (
        // A bundle glyph the shell does not know: the title's initial, as
        // the tool rail falls back.
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {title.slice(0, 1).toUpperCase()}
        </span>
      )}
    </button>
  );
}

const sepStyle: React.CSSProperties = {
  width: 1,
  height: 22,
  background: "var(--pg-border)",
  margin: "0 6px",
  flexShrink: 0,
};

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  height: "var(--chrome-toolbar-h)",
  padding: "0 10px",
  gap: 12,
  background: "var(--chrome-panel-bg)",
  borderBottom: "1px solid var(--chrome-border)",
  flexShrink: 0,
};

const leftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  overflow: "hidden",
};

const rightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
};
