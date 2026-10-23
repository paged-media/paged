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

// Design system (publishing cockpit) — the 64px right-edge panel
// launcher (the kit's panel-selector rail). Each entry opens its
// panel as a right-dock tab (or closes it when it is already the
// open tab) — panels surface in ONE predictable place, never
// scattered. Config comes from the app
// (`<PagedShell panelRail={...}>`) — the shell renders, never
// hardcodes the list.
//
// A rail button always brings its panel into view (editor ADR 271). With
// the panels hidden (Shift+Tab keeps this rail and hides the dock), it
// shows the dock again with its panel active; it used to switch the tab of
// the hidden dock, so the click did nothing anyone could see, and with
// the panel already active it closed it. Only a panel the user can SEE
// closes from its rail button. The open is not a transition either: a
// transition waits behind any other work, and with many panels mounted
// the switch could land seconds after the click, or look like none.

import { hasIcon, Icon } from "../icons";
import { useRovingFocus } from "../focus/roving-focus";
import { PluginGlyph } from "../icons/plugin-glyph";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useOptionalCockpitState } from "../cockpit/cockpit-state-context";
import { Segment } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";
import { filterByRegion } from "../profile/region-filter";
import { useChromeRegions } from "../state/chrome-regions";
import { PANEL_RAIL } from "./messages";

export interface PanelRailItem {
  /** A registered panel id (`paged.swatches`, …). */
  panelId: string;
  /** Short launcher label, e.g. "Swatches". */
  title: string;
  /** Glyph name. */
  icon: string;
  /** Cockpit — steer the Properties inspector when this item
   *  activates (the kit's Text / Image / Pages rail clicks all
   *  open Properties with a different sub-inspector). */
  inspectorContext?: "text" | "image" | "page";
}

export function PanelRail({
  items,
  panelsHidden = false,
  onRevealPanels,
}: {
  items: PanelRailItem[];
  /** The dock is hidden (Shift+Tab): a rail button shows it again. */
  panelsHidden?: boolean;
  onRevealPanels?: () => void;
}) {
  const strings = useStrings();
  const cockpit = useOptionalCockpitState();
  // K-8 — the rail DOOR: registered panels that opted in (`rail: true`)
  // render as launcher items after the app's built-ins. Registry-derived
  // + live (a bundle activating later appears; a disposed one drops),
  // read through a view that changes with the registry (state/live.ts).
  const panels = useRegistryView(useRegistries().panels);
  const pluginItems = panels
    .list()
    .filter((p) => p.rail)
    .map((p) => ({ panelId: p.id, title: p.title, icon: p.icon ?? "" }));
  // The editor profile's panel rail (docs/composable-editor.md §5.2): the
  // app's launchers it keeps, in its order; the bundles' rail panels stay
  // where the list says `@bundles`.
  const railRegion = useChromeRegions().region("panel-rail");
  const features = useRegistryView(useRegistries().features);
  const offeredPanel = (i: PanelRailItem) =>
    features.allows("panel", i.panelId);
  const hostShown = filterByRegion(
    railRegion,
    items,
    (i) => i.panelId,
    () => false,
  ).filter(offeredPanel);
  const pluginShown = filterByRegion(
    railRegion,
    pluginItems,
    (i) => i.panelId,
    () => true,
  ).filter(offeredPanel);
  // One tab stop for the rail; Up/Down walk it (ADR 234).
  const roving = useRovingFocus({
    orientation: "vertical",
    items: "[data-panel-rail-item]",
  });

  if (!cockpit || (hostShown.length === 0 && pluginShown.length === 0))
    return null;

  const isActive = (item: PanelRailItem) =>
    cockpit.activeTab === item.panelId &&
    (item.inspectorContext == null ||
      cockpit.inspectorContext === item.inspectorContext);

  const toggle = (item: PanelRailItem) => {
    const contribution = panels.get(item.panelId);
    if (!contribution) return;
    // Active → close (and clear the steer); otherwise ensure +
    // activate, steering the Properties sub-inspector when the item
    // carries a context (kit Text/Image/Pages).
    if (panelsHidden) {
      onRevealPanels?.();
      cockpit.openPanel(item.panelId);
      cockpit.setInspectorContext(item.inspectorContext ?? null);
      return;
    }
    if (isActive(item)) {
      cockpit.closeTab(item.panelId);
      if (item.inspectorContext) cockpit.setInspectorContext(null);
      return;
    }
    cockpit.openPanel(item.panelId);
    cockpit.setInspectorContext(item.inspectorContext ?? null);
  };

  const renderItem = (item: PanelRailItem, plugin: boolean) => {
    const active = isActive(item);
    return (
      <Segment
        key={`${item.panelId}:${item.inspectorContext ?? ""}`}
        pressed={active}
        data-panel-rail-item={
          item.inspectorContext
            ? `${item.panelId}:${item.inspectorContext}`
            : item.panelId
        }
        title={item.title}
        onClick={() => toggle(item)}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          width: 56,
          padding: "7px 0 6px",
          borderRadius: "var(--radius-md)",
          border: "none",
          cursor: "pointer",
          background: active ? "var(--selected-bg)" : "transparent",
          color: active ? "var(--pg-primary)" : "var(--chrome-icon)",
        }}
      >
        {plugin && !hasIcon(item.icon) && panels.get(item.panelId)?.iconSvg ? (
          <PluginGlyph svg={panels.get(item.panelId)!.iconSvg!} size={17} />
        ) : (
          <Icon name={item.icon} size={17} />
        )}
        <span style={{ fontSize: 9.5, lineHeight: 1 }}>{item.title}</span>
      </Segment>
    );
  };

  return (
    <div
      data-panel-rail
      role="toolbar"
      aria-label={strings.t(PANEL_RAIL.label)}
      aria-orientation="vertical"
      style={railStyle}
      {...roving}
    >
      {hostShown.map((item) => renderItem(item, false))}
      {pluginShown.length > 0 && hostShown.length > 0 && (
        <div
          aria-hidden
          style={{
            width: 28,
            borderTop: "1px solid var(--chrome-border)",
            margin: "4px 0",
          }}
        />
      )}
      {pluginShown.map((item) => renderItem(item, true))}
    </div>
  );
}

const railStyle: React.CSSProperties = {
  width: 64,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  padding: "8px 0",
  borderLeft: "1px solid var(--chrome-border)",
  background: "var(--chrome-rail-bg)",
  overflowY: "auto",
};
