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

// The edit-context BREADCRUMB (closes plugin-draw B-02 / plugin-web W-03;
// editor ADRs 1212 and 1213). The trail of where the user is, root→top:
// each entered group (Track L, ADR 250) and then each entered context,
// named as the module names it (`label`, F-45). Clicking an ancestor
// goes back to that level and keeps it; clicking the last level leaves
// it; the Esc button leaves one level as Escape does. Every context
// level leaves through the exit resolver (ADR 1212). Shows nothing when
// nothing is entered.
//
// WHERE (F-48, UXI-CTX-008): the context toolbar carries the trail in its
// fixed-height bar (`ContextTrail`), so entering a context moves nothing.
// Where a profile shows no context toolbar the trail floats over the top
// of the work area (`EditContextBreadcrumb`), taking no row of its own.

import { useEffect, useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import type { ElementId } from "@paged-media/client";

import { useEditContextStack } from "../state/edit-context-stack";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useSelection } from "../state/selection-context";
import {
  createValueStore,
  scoped,
  useEditorScope,
} from "../state/editor-scope";
import { EDIT_CONTEXT } from "./messages";
import { chrome, font, radius, space } from "@paged-media/panel-kit";

/** How many context toolbars carry the trail in this editor. */
const HOSTS = scoped("breadcrumbHosts", () => createValueStore(0));

/** A bar that shows `ContextTrail` itself (the context toolbar) mounts
 *  this: the floating trail then stays away. */
export function useHostsContextTrail(): void {
  const scope = useEditorScope();
  useEffect(() => {
    const hosts = scope.get(HOSTS);
    hosts.set(hosts.get() + 1);
    return () => hosts.set(hosts.get() - 1);
  }, [scope]);
}

/** The trail where no context toolbar carries it: over the work area,
 *  taking no layout (F-48). */
export function EditContextBreadcrumb() {
  const scope = useEditorScope();
  const hosts = scope.get(HOSTS);
  const hosted = useSyncExternalStore(hosts.subscribe, hosts.get, hosts.get);
  if (hosted > 0) return null;
  return (
    <div style={floatWrapStyle}>
      <ContextTrail floating />
    </div>
  );
}

interface Level {
  kind: "group" | "context";
  key: string;
  label: string;
  /** The context type, for `data-edit-context-crumb`. */
  type?: string;
}

/** The trail itself: the entered groups, then the entered contexts. */
export function ContextTrail({ floating = false }: { floating?: boolean }) {
  const strings = useStrings();
  const { breadcrumb, leaveTo, leave } = useEditContextStack();
  const {
    activeGroupPath,
    setActiveGroup,
    setElementSelection,
    setElementGeometry,
  } = useSelection();
  const client = useOptionalCanvasClient();
  if (breadcrumb.length === 0 && activeGroupPath.length === 0) return null;

  const levels: Level[] = [
    ...activeGroupPath.map((id) => ({
      kind: "group" as const,
      key: `group:${id}`,
      label: strings.t(EDIT_CONTEXT.group),
    })),
    ...breadcrumb.map((frame) => ({
      kind: "context" as const,
      key: frame.id,
      label: frame.label,
      type: frame.type,
    })),
  ];

  const select = (id: ElementId) => {
    if (!client) return;
    void client
      .setElementSelection([id], "replace")
      .then(async (ids) => {
        setElementSelection(ids);
        setElementGeometry(await client.elementGeometry(ids));
      })
      .catch(() => {});
  };
  const groupRef = (id: string) => ({ kind: "group", id }) as ElementId;

  // Back to the group level `g` (an index into the group path): the
  // contexts leave first; the last group, with nothing above it, is left.
  const toGroup = async (g: number) => {
    const hadContexts = breadcrumb.length > 0;
    if (!(await leaveTo(0, "breadcrumb"))) return;
    const isLast = g === activeGroupPath.length - 1;
    if (isLast && hadContexts) return;
    if (isLast) {
      setActiveGroup(activeGroupPath[g - 1] ?? null, activeGroupPath);
      select(groupRef(activeGroupPath[g]!));
      return;
    }
    setActiveGroup(activeGroupPath[g]!, activeGroupPath);
    select(groupRef(activeGroupPath[g + 1]!));
  };

  const onLevel = (i: number) => {
    const level = levels[i]!;
    if (level.kind === "group") {
      void toGroup(i);
      return;
    }
    const depth = i - activeGroupPath.length;
    // The last crumb leaves its level; an ancestor is gone back to.
    const isLast = i === levels.length - 1;
    void leaveTo(isLast ? depth : depth + 1, "breadcrumb");
  };

  const exitOne = () => {
    if (breadcrumb.length > 0) leave("escape");
    else void toGroup(activeGroupPath.length - 1);
  };

  return (
    <nav
      data-edit-context-breadcrumb
      data-floating={floating ? "true" : undefined}
      aria-label={strings.t(EDIT_CONTEXT.label)}
      style={floating ? floatingBarStyle : inlineStyle}
    >
      <span className="pg-ui-xs" style={kickerStyle}>
        {strings.t(EDIT_CONTEXT.editing)}
      </span>
      {levels.map((level, i) => {
        const isActive = i === levels.length - 1;
        return (
          <span key={level.key} style={crumbWrapStyle}>
            {i > 0 && (
              <span aria-hidden style={sepStyle}>
                ›
              </span>
            )}
            <button
              type="button"
              data-edit-context-crumb={level.type}
              data-group-crumb={level.kind === "group" ? "" : undefined}
              data-active={isActive ? "true" : undefined}
              data-context-label={
                isActive && level.kind === "context" ? "" : undefined
              }
              aria-current={isActive ? "location" : undefined}
              onClick={() => onLevel(i)}
              style={{
                ...crumbStyle,
                color: isActive
                  ? "var(--overlay-selection, #d4127a)"
                  : "var(--pg-muted-fg)",
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {level.label}
            </button>
          </span>
        );
      })}
      <button
        type="button"
        data-edit-context-exit
        onClick={exitOne}
        title={strings.t(EDIT_CONTEXT.exit)}
        style={exitStyle}
      >
        Esc
      </button>
    </nav>
  );
}

const floatWrapStyle: React.CSSProperties = {
  position: "relative",
  height: 0,
  overflow: "visible",
  zIndex: 30,
};

const floatingBarStyle: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: space[2],
  height: 28,
  padding: `0 ${space[3]}`,
  border: `1px solid ${chrome.border}`,
  borderRadius: radius.md,
  background: "var(--chrome-panel-bg, var(--pg-bg))",
  boxShadow: "0 2px 8px rgb(0 0 0 / 0.12)",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const inlineStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space[2],
  minWidth: 0,
  fontSize: 12,
  whiteSpace: "nowrap",
};

const kickerStyle: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: font.trackingWide,
  color: "var(--pg-muted-fg)",
  marginRight: 2,
};

const crumbWrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: space[2],
};

const crumbStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "2px 4px",
  cursor: "pointer",
  font: "inherit",
};

const sepStyle: React.CSSProperties = {
  color: "var(--pg-muted-fg)",
  opacity: 0.6,
};

const exitStyle: React.CSSProperties = {
  marginLeft: space[2],
  background: "none",
  border: `1px solid ${chrome.border}`,
  borderRadius: radius.sm,
  padding: "1px 6px",
  fontSize: 11,
  color: "var(--pg-muted-fg)",
  cursor: "pointer",
};
