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

// Design system — the zoom field and its menu, in the bottom bar beside
// the slider (kit chrome.jsx "50% ▾").
//
// The field is editable (interaction contract §13.2, UXI-CAM-007; editor
// ADR "Navigation history and one current page"): type a percentage
// ("150", "150 %") and Enter zooms about the viewport's centre, held inside
// the one zoom range; the field then shows the result as normalised, so
// 9,000 % reads 4,000 %. Escape restores the live value. A typed zoom is a
// zoom, not a navigation: it records no Back entry.
//
// The menu groups the fits (Fit page, Fit spread, Fit selection, Fit
// document), 100 % (a camera scale of 1: a point per CSS px), the named
// views of ADR 1201 D-12 (Actual size: an inch as 96 CSS px; Calibrated
// size: an inch as an inch on this screen), the zoom steps and presets,
// and the screen calibration. Every entry but the presets invokes the
// registered command, so it behaves as the View menu and the keys do.

import { useState } from "react";
import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import { useCamera } from "../state/camera-context";
import {
  parseZoomPercent,
  ZOOM_PRESET_SCALES,
  zoomCameraTo,
} from "../state/zoom-range";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ZOOM } from "./messages";

// The labels are message keys (./messages), read at render; each group is
// divided from the next.
const ZOOM_GROUPS: ReadonlyArray<ReadonlyArray<[string, string]>> = [
  [
    [ZOOM.fitPage, "paged.view.fitPage"],
    [ZOOM.fitSpread, "paged.view.fitSpread"],
    [ZOOM.fitSelection, "paged.view.fitSelection"],
    [ZOOM.fitDocument, "paged.view.zoomFit"],
  ],
  [
    [ZOOM.zoom100, "paged.view.zoom100"],
    [ZOOM.actualSize, "paged.view.actualSize"],
    [ZOOM.calibratedSize, "paged.view.calibratedSize"],
  ],
  [
    [ZOOM.zoomIn, "paged.view.zoomIn"],
    [ZOOM.zoomOut, "paged.view.zoomOut"],
  ],
];

/** A camera scale as the field shows it: a whole percentage. */
export function formatZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function ZoomControl({
  side = "bottom",
}: { side?: "top" | "bottom" } = {}) {
  const strings = useStrings();
  const { camera, setCamera, viewportSize } = useCamera();
  // Read through a view of the registry (state/live.ts, ADR 229). A
  // camera re-render alone would not do: compiled, `commands.get(id)` is
  // kept for as long as the registry object is the same, and it always is.
  const commands = useRegistryView(useRegistries().commands);
  // The text being typed, until Enter or blur commits it; null shows the
  // live zoom.
  const [draft, setDraft] = useState<string | null>(null);
  const live = formatZoomPercent(camera.scale);

  const commit = () => {
    if (draft === null) return;
    const scale = parseZoomPercent(draft);
    if (scale !== null) setCamera(zoomCameraTo(camera, scale, viewportSize));
    setDraft(null);
  };

  return (
    <div data-zoom-control style={groupStyle}>
      <input
        data-zoom-field
        aria-label={strings.t(ZOOM.field)}
        inputMode="decimal"
        spellCheck={false}
        value={draft ?? live}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            // The field's own Escape: back to the live zoom, the focus
            // stays in the field.
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
        style={fieldStyle}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          data-zoom-menu
          aria-label={strings.t(ZOOM.menu)}
          style={triggerStyle}
        >
          <Icon name="ui-chevron-down" size={13} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side={side} sideOffset={4}>
          {ZOOM_GROUPS.map((group, g) => (
            <div key={g} role="group">
              {g > 0 && <DropdownMenuSeparator />}
              {group.map(([label, id]) =>
                commands.get(id) ? (
                  <DropdownMenuItem
                    key={id}
                    data-zoom-item={id}
                    onSelect={() => void commands.invoke(id)}
                  >
                    {strings.t(label)}
                  </DropdownMenuItem>
                ) : null,
              )}
            </div>
          ))}
          <DropdownMenuSeparator />
          {ZOOM_PRESET_SCALES.map((scale) => (
            <DropdownMenuItem
              key={scale}
              data-zoom-preset={scale}
              onSelect={() =>
                setCamera(zoomCameraTo(camera, scale, viewportSize))
              }
            >
              {Math.round(scale * 100)}%
            </DropdownMenuItem>
          ))}
          {commands.get("paged.view.calibrateScreen") ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-zoom-item="paged.view.calibrateScreen"
                onSelect={() =>
                  void commands.invoke("paged.view.calibrateScreen")
                }
              >
                {strings.t(ZOOM.calibrate)}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const groupStyle = {
  display: "inline-flex",
  alignItems: "center",
  height: 26,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--pg-border)",
  overflow: "hidden",
} as const;

const fieldStyle = {
  width: 52,
  height: "100%",
  padding: "0 2px 0 8px",
  border: "none",
  outline: "none",
  background: "transparent",
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 12,
  color: "var(--pg-fg)",
} as const;

const triggerStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  // WCAG 2.5.8: a pointer target of 24 px at least.
  width: 24,
  minHeight: 24,
  height: "100%",
  border: "none",
  borderLeft: "1px solid var(--pg-border)",
  background: "transparent",
  cursor: "pointer",
  color: "var(--pg-fg)",
} as const;
