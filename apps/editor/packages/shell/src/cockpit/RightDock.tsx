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

// Cockpit — the right dock: the kit's DockGroup (right-panels.jsx).
// A 36px tab strip (icon · title · close ✕, active tab carries the
// 2px violet underline) over the active panel. The strip hides when
// only one tab is open — the kit's "single fixed inspector" look in
// the non-design modes. The ONLY tabbed surface in the app; panels
// never float or re-dock elsewhere.
//
// Every open tab's panel stays mounted (ADR 240): the inactive ones sit
// in a hidden <Activity>, which keeps their state and DOM (a scrolled
// list, a half-typed field, an expanded section) and unmounts their
// effects, so a hidden panel holds no subscription and fetches nothing.
// Switching tabs reveals a panel instead of mounting it again. Each panel
// scrolls in its own container, so each keeps its scroll position.
//
// The strip is an ARIA tablist (UX audit F-50, ADR 259): each tab a
// `tab` with `aria-selected`, one tab stop (the active tab), the arrows,
// Home and End moving to and opening a neighbour, Delete closing the tab;
// the panel under it is the `tabpanel` it controls.
//
// Tabs fit the dock (UX audit F-20, ADR 265): the active tab keeps its
// whole label, the others shrink to their icon and an ellipsis (the
// title is the tooltip), and once even that does not fit, a "More
// panels" button at the strip's end lists every open tab.
//
// A switch from the strip is a view transition (ADR 240): the incoming
// panel comes in from the side its tab is on, the outgoing one leaves the
// other way; under reduced motion it just switches.

import { Activity, ViewTransition, useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Icon, hasIcon } from "../icons";
import { PluginGlyph } from "../icons/plugin-glyph";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import {
  ENTER_DIRECTIONAL,
  EXIT_DIRECTIONAL,
  directionOf,
  transitionWith,
} from "../view-transitions";
import { useCockpitState } from "./cockpit-state-context";
import { PanelHost } from "./PanelHost";

export function RightDock() {
  const { rightTabs, activeTab, activateTab, closeTab } = useCockpitState();
  const panels = useRegistryView(useRegistries().panels);

  // Resolve tabs against the registry — a disposed plugin panel
  // simply drops out of the strip (read through a view that changes with
  // the registry, state/live.ts, ADR 229).
  const tabs = rightTabs
    .map((id) => panels.get(id))
    .filter((c): c is NonNullable<typeof c> => c != null);
  const active = activeTab && panels.get(activeTab) ? activeTab : null;
  const switchTo = (id: string) => {
    if (id === active) return;
    const order = tabs.map((t) => t.id);
    transitionWith(
      directionOf(order.indexOf(active ?? ""), order.indexOf(id)),
      () => activateTab(id),
    );
  };

  // The strip scrolls sideways once tabs outgrow the dock. Opening a
  // panel (menu, palette, a pill) activates a tab that was then usually
  // out of sight to the right — the panel changed and its tab did not
  // appear. Bring the active tab into view; let the wheel scroll the strip.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabDomId = (id: string) => `pg-dock-tab-${id.replace(/[^\w-]/g, "_")}`;
  const panelDomId = (id: string) =>
    `pg-dock-panel-${id.replace(/[^\w-]/g, "_")}`;
  /** The tablist's keys (WAI-ARIA tabs, automatic activation). */
  const onStripKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order = tabs.map((t) => t.id);
    const at = order.indexOf(active ?? "");
    if (at < 0 || order.length === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (at + 1) % order.length;
    else if (e.key === "ArrowLeft")
      next = (at - 1 + order.length) % order.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else if (e.key === "Delete") {
      const t = tabs[at];
      if (t && t.closable !== false) {
        e.preventDefault();
        closeTab(t.id);
      }
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const id = order[next]!;
    switchTo(id);
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-dock-tab="${CSS.escape(id)}"]`)
      ?.focus();
  };
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !active) return;
    const tab = strip.querySelector<HTMLElement>(
      `[data-dock-tab="${CSS.escape(active)}"]`,
    );
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, rightTabs]);

  // Whether the shrunk tabs still overflow the strip: then the "More
  // panels" menu shows. Measured on every resize of the strip and every
  // change of the open tabs.
  const [overflowing, setOverflowing] = useState(false);
  const many = tabs.length > 1;
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      setOverflowing(false);
      return;
    }
    const measure = () =>
      setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTabs, active, many]);

  return (
    <div
      data-right-dock
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      {many && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 36,
            background: "var(--chrome-panel-bg)",
            borderBottom: "1px solid var(--chrome-border)",
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <div
            ref={stripRef}
            data-dock-strip
            data-overflowing={overflowing || undefined}
            role="tablist"
            aria-label="Panels"
            onKeyDown={onStripKey}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.currentTarget.scrollLeft += e.deltaY;
              }
            }}
            style={{
              display: "flex",
              alignItems: "stretch",
              flex: 1,
              minWidth: 0,
              overflowX: "auto",
              scrollbarWidth: "none",
            }}
          >
            {tabs.map((t) => {
              const a = active === t.id;
              const icon = t.icon && hasIcon(t.icon) ? t.icon : undefined;
              // K-8 — a plugin-supplied sanitized glyph fills the gap a
              // host-unknown icon name used to leave (an iconless tab).
              const svg = !icon ? t.iconSvg : undefined;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={tabDomId(t.id)}
                  aria-selected={a}
                  aria-controls={panelDomId(t.id)}
                  tabIndex={a ? 0 : -1}
                  data-dock-tab={t.id}
                  data-active={a || undefined}
                  title={t.title}
                  onClick={() => switchTo(t.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 12px",
                    // The active tab keeps its whole label; the others give
                    // way down to their icon and an ellipsis.
                    flex: a ? "0 0 auto" : "0 1 auto",
                    minWidth: a ? undefined : icon || svg ? 40 : 52,
                    maxWidth: "100%",
                    border: "none",
                    cursor: "pointer",
                    background: a ? "var(--pg-bg)" : "transparent",
                    color: a ? "var(--pg-fg)" : "var(--pg-muted-fg)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12.5,
                    fontWeight: a ? 600 : 500,
                    borderBottom: a
                      ? "2px solid var(--pg-primary)"
                      : "2px solid transparent",
                    borderRight: "1px solid var(--chrome-border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {icon && (
                    <Icon
                      name={icon}
                      size={13}
                      style={{ opacity: 0.85, flexShrink: 0 }}
                    />
                  )}
                  {svg && <PluginGlyph svg={svg} size={13} />}
                  <span
                    data-dock-tab-label
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.title}
                  </span>
                  {a && t.closable !== false && (
                    <span
                      role="button"
                      aria-label={`Close ${t.title}`}
                      data-dock-tab-close={t.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                      style={{
                        display: "inline-flex",
                        opacity: 0.4,
                        marginLeft: 2,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="ui-x" size={12} />
                    </span>
                  )}
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
          </div>
          {overflowing && (
            <DropdownMenu>
              <DropdownMenuTrigger
                data-dock-overflow
                aria-label="More panels"
                title="More panels"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  flexShrink: 0,
                  border: "none",
                  borderLeft: "1px solid var(--chrome-border)",
                  background: "transparent",
                  color: "var(--pg-muted-fg)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Icon name="ui-chevron-down" size={13} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                {tabs.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    data-dock-overflow-item={t.id}
                    data-active={t.id === active || undefined}
                    onSelect={() => switchTo(t.id)}
                    style={t.id === active ? { fontWeight: 600 } : undefined}
                  >
                    {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {!active && (
          <div className="pg-ui-xs" style={{ padding: 16, opacity: 0.6 }}>
            No panel open.
          </div>
        )}
        {tabs.map((t) => (
          <Activity
            key={t.id}
            mode={t.id === active ? "visible" : "hidden"}
            name={t.id}
          >
            <ViewTransition
              enter={ENTER_DIRECTIONAL}
              exit={EXIT_DIRECTIONAL}
              update="none"
              share="none"
            >
              <div
                data-dock-panel={t.id}
                id={panelDomId(t.id)}
                {...(tabs.length > 1
                  ? { role: "tabpanel", "aria-labelledby": tabDomId(t.id) }
                  : null)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                <PanelHost id={t.id} />
              </div>
            </ViewTransition>
          </Activity>
        ))}
      </div>
    </div>
  );
}
