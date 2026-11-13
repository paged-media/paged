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

// Editor ADR 298 — what bundles contribute to the control bar and the
// status bar for an edit context (extensions ADR 348, C1 and C3). The
// scope a group or an item follows is the ACTIVE context: the frame-level
// edit context, else the document context a bundle holds for the open
// document (`activeScopeContext`). Each contribution renders in its own
// error boundary: a bundle's crash is a gap in the bar, never a blank
// editor.

import { Component, type ReactNode } from "react";

import { activeScopeContext } from "../registries/context-bar";
import { useRegistryView } from "../state/live";
import { useOptionalPaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";

/** The context the scoped contributions follow now (null for none). */
export function useActiveScopeContext(): string | null {
  return activeScopeContext(useOptionalPaged());
}

class ContributionBoundary extends Component<
  { id: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.id}] contribution failed:`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The control-bar groups contributed for `editContext`, in order. Renders
 *  nothing when there are none. */
export function ContributedControlBarGroups({
  editContext,
}: {
  editContext: string | null;
}) {
  const registry = useRegistryView(useRegistries().controlBarGroups);
  const groups = registry.forContext(editContext);
  if (editContext === null || groups.length === 0) return null;
  return (
    <>
      {groups.map((g) => {
        const Render = g.render;
        return (
          <span
            key={g.id}
            data-control-bar-group={g.id}
            role="group"
            aria-label={g.title ?? g.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexShrink: 0,
            }}
          >
            <ContributionBoundary id={g.id}>
              <Render editContext={editContext} />
            </ContributionBoundary>
          </span>
        );
      })}
    </>
  );
}

/** Are there control-bar groups for `editContext`? */
export function useHasControlBarGroups(editContext: string | null): boolean {
  const registry = useRegistryView(useRegistries().controlBarGroups);
  return registry.forContext(editContext).length > 0;
}

/**
 * The status bar under the canvas (editor ADR 298): the status items
 * contributed for the active context, start-aligned ones left, end-aligned
 * right. Rendered only while some item applies, so a document no bundle
 * claims keeps the canvas column as it was.
 *
 * Entering or leaving a frame's edit context never moves the canvas
 * (editor ADR 1212, UXI-CTX-008): the bar takes a row of the layout only
 * while the DOCUMENT context has items (then it stays, empty if need be,
 * whatever context is entered); items that apply only because a frame's
 * context is entered float over the canvas's bottom edge.
 */
export function StatusBar() {
  const editContext = useActiveScopeContext();
  const paged = useOptionalPaged() as {
    documentContext?: string | null;
  } | null;
  const documentContext = paged?.documentContext ?? null;
  const registry = useRegistryView(useRegistries().statusItems);
  const items = editContext === null ? [] : registry.forContext(editContext);
  const reserved =
    documentContext !== null && registry.forContext(documentContext).length > 0;
  if (items.length === 0 && !reserved) return null;
  const bar = <StatusRow editContext={editContext} items={items} />;
  return reserved ? (
    bar
  ) : (
    <div data-status-bar-float="" style={floatWrapStyle}>
      <div style={floatBarStyle}>{bar}</div>
    </div>
  );
}

const floatWrapStyle: React.CSSProperties = {
  position: "relative",
  height: 0,
  overflow: "visible",
  zIndex: 20,
};

const floatBarStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
};

function StatusRow({
  editContext,
  items,
}: {
  editContext: string | null;
  items: ReturnType<
    ReturnType<typeof useRegistries>["statusItems"]["forContext"]
  >;
}) {
  const side = (align: "start" | "end") =>
    items
      .filter((i) => (i.align ?? "start") === align)
      .map((i) => {
        const Render = i.render;
        return (
          <span
            key={i.id}
            data-status-item={i.id}
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            <ContributionBoundary id={i.id}>
              <Render editContext={editContext ?? ""} />
            </ContributionBoundary>
          </span>
        );
      });
  return (
    <div
      data-status-bar={editContext ?? undefined}
      role="status"
      aria-live="polite"
      className="pg-ui-xs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        height: 24,
        padding: "0 12px",
        borderTop: "1px solid var(--chrome-border)",
        background: "var(--chrome-panel-bg)",
        color: "var(--pg-muted-fg)",
        fontVariantNumeric: "tabular-nums",
        flexShrink: 0,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {side("start")}
      <span style={{ flex: 1 }} />
      {side("end")}
    </div>
  );
}
