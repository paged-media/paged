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

// Design system (publishing cockpit) — the bottom mode bar
// (`--chrome-modebar-h`, 48 px at the default density).
// Six workflow modes, one product: the switcher is the cockpit's
// primary navigation. The centre lists the registered modes; the right
// side carries zoom (dropdown + slider). The save state moved to the
// header, beside the document name.

import { useState, type ReactNode } from "react";

import { Icon } from "../icons";
import { useRovingFocus } from "../focus/roving-focus";
import { ZoomControl } from "./ZoomControl";
import { EditingAidsControl } from "./EditingAidsControl";
import { useWorkspaceClass } from "../cockpit/workspace-class";
import { useCamera, useNavigationHistoryState } from "../state/camera-context";
import { ZOOM_MAX_SCALE, ZOOM_MIN_SCALE } from "../state/zoom-range";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import {
  useWorkflowMode,
  type WorkflowMode,
} from "../state/workflow-mode-context";
import { Segment } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import { MODE_SWITCHER } from "./messages";

export interface ModeSwitcherProps {
  right?: ReactNode;
}

export function ModeSwitcher({ right }: ModeSwitcherProps) {
  const strings = useStrings();
  const { mode, setMode } = useWorkflowMode();
  // A view of the registry (state/live.ts, ADR 229): a bundle that
  // registers a mode after the first render shows up.
  const modes = useRegistryView(useRegistries().modes);
  // F-23 — a placeholder mode is not offered beside the working ones
  // (shown only while it is the active mode, so the bar never hides where
  // the user is).
  const list = modes.list().filter((m) => !m.placeholder || m.id === mode);
  // A narrow workspace (F-55): the modes keep their icons and drop their
  // labels, and the zoom slider gives way to the zoom field.
  const narrow = useWorkspaceClass() === "narrow";
  // One tab stop for the modes; Left/Right walk them (ADR 234).
  const roving = useRovingFocus({
    orientation: "horizontal",
    items: "[data-mode-option]",
  });
  if (list.length === 0) return null;

  return (
    <div data-mode-switcher style={barStyle}>
      <div style={sideStyle}>
        {/* The save state moved to the header's document chip, beside
            the name it describes. */}
      </div>

      <div
        role="toolbar"
        aria-label={strings.t(MODE_SWITCHER.label)}
        style={centerStyle}
        {...roving}
      >
        {list.map((m) => (
          <ModeButton
            key={m.id}
            id={m.id}
            title={m.title}
            icon={m.icon}
            blurb={m.blurb}
            active={m.id === mode}
            iconOnly={narrow}
            onClick={() => setMode(m.id)}
          />
        ))}
      </div>

      <div style={{ ...sideStyle, justifyContent: "flex-end" }}>
        {right ?? <ZoomCluster slider={!narrow} />}
      </div>
    </div>
  );
}

/** Kit chrome.jsx — the bottom-right zoom cluster: the editing aids and
 *  Proof view, Back and Forward
 *  through the navigation history, the zoom field and its menu (fits,
 *  named views, presets) and a log-scale slider that zooms around the
 *  viewport centre. */
function ZoomCluster({ slider }: { slider: boolean }) {
  const strings = useStrings();
  const { camera, setCamera, viewportSize } = useCamera();
  const commands = useRegistryView(useRegistries().commands);
  const history = useNavigationHistoryState();
  // The one zoom range (ADR 246, ADR 1201 D-12), on a log scale: three
  // decades, so page-fit zooms (~5–60 %) keep usable travel.
  const MIN = Math.log(ZOOM_MIN_SCALE);
  const MAX = Math.log(ZOOM_MAX_SCALE);
  const pos = Math.min(
    1,
    Math.max(
      0,
      (Math.log(Math.max(camera.scale, ZOOM_MIN_SCALE)) - MIN) / (MAX - MIN),
    ),
  );
  const onInput = (v: number) => {
    const scale = Math.exp(MIN + v * (MAX - MIN));
    const [vw, vh] = viewportSize;
    const cx = vw / 2;
    const cy = vh / 2;
    const k = scale / Math.max(camera.scale, 1e-6);
    setCamera({
      scale,
      tx: cx - (cx - camera.tx) * k,
      ty: cy - (cy - camera.ty) * k,
    });
  };
  return (
    <div
      data-zoom-cluster
      style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}
    >
      <EditingAidsControl side="top" />
      {commands.get("paged.view.navigateBack") && (
        <div style={{ display: "inline-flex", gap: 2 }} data-navigation-history>
          <HistoryButton
            id="paged.view.navigateBack"
            icon="ui-chevron-left"
            label={strings.t(MODE_SWITCHER.back)}
            disabled={history.back === 0}
            onClick={() => void commands.invoke("paged.view.navigateBack")}
          />
          <HistoryButton
            id="paged.view.navigateForward"
            icon="ui-chevron-right"
            label={strings.t(MODE_SWITCHER.forward)}
            disabled={history.forward === 0}
            onClick={() => void commands.invoke("paged.view.navigateForward")}
          />
        </div>
      )}
      <ZoomControl side="top" />
      {slider && (
        <>
          <input
            type="range"
            aria-label={strings.t(MODE_SWITCHER.zoom)}
            min={0}
            max={1000}
            value={Math.round(pos * 1000)}
            onChange={(e) => onInput(Number(e.target.value) / 1000)}
            style={{ width: 84, accentColor: "var(--pg-primary)" }}
          />
          <Icon
            name="ui-displays"
            size={15}
            style={{ color: "var(--pg-muted-fg)" }}
          />
        </>
      )}
    </div>
  );
}

/** Back or Forward: an icon button that runs its command. */
function HistoryButton(props: {
  id: string;
  icon: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-navigation={props.id}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 26,
        border: "none",
        borderRadius: "var(--radius-md)",
        background: "transparent",
        color: "var(--chrome-menu-text)",
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.4 : 1,
      }}
    >
      <Icon name={props.icon} size={15} />
    </button>
  );
}

function ModeButton(props: {
  id: WorkflowMode;
  title: string;
  icon: string;
  blurb?: string;
  active: boolean;
  iconOnly: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Segment
      pressed={props.active}
      data-mode-option={props.id}
      title={props.blurb ?? props.title}
      aria-label={props.iconOnly ? props.title : undefined}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: "calc(var(--density-control-h) + 2px)",
        padding: props.iconOnly ? "0 9px" : "0 13px",
        borderRadius: "var(--radius-md)",
        border: "none",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: 12.5,
        fontWeight: props.active ? 600 : 400,
        background: props.active
          ? "var(--pg-primary)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: props.active
          ? "var(--pg-primary-fg)"
          : "var(--chrome-menu-text)",
      }}
    >
      <Icon name={props.icon} size={15} />
      {!props.iconOnly && props.title}
    </Segment>
  );
}

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
  height: "var(--chrome-modebar-h)",
  padding: "0 14px",
  gap: 12,
  background: "var(--chrome-panel-bg)",
  borderTop: "1px solid var(--chrome-border)",
  flexShrink: 0,
};

const sideStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};
