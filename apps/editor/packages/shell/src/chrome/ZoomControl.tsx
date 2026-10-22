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

// Design system — the zoom dropdown (kit chrome.jsx "50% ▾"), in the
// bottom bar beside the slider (it was in the header as well).
// REAL: the percentage reads the live camera scale; the menu items
// invoke the registered zoom commands (zoom in / out / 100% / fit),
// so behaviour matches the View menu and keyboard shortcuts.

import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import { useCamera } from "../state/camera-context";
import { ZOOM_PRESET_SCALES, zoomCameraTo } from "../state/zoom-range";
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

// The fits first, as InDesign's zoom menu lists them, then the steps;
// the presets follow (UX audit F-31, ADR 257).
// The labels are message keys (./messages), read at render.
const ZOOM_ITEMS: Array<[string, string]> = [
  [ZOOM.fitPage, "paged.view.fitPage"],
  [ZOOM.fitSpread, "paged.view.fitSpread"],
  [ZOOM.fitSelection, "paged.view.fitSelection"],
  [ZOOM.fitDocument, "paged.view.zoomFit"],
  [ZOOM.zoomIn, "paged.view.zoomIn"],
  [ZOOM.zoomOut, "paged.view.zoomOut"],
  [ZOOM.zoom100, "paged.view.zoom100"],
];

export function ZoomControl({
  side = "bottom",
}: { side?: "top" | "bottom" } = {}) {
  const strings = useStrings();
  const { camera, setCamera, viewportSize } = useCamera();
  // Read through a view of the registry (state/live.ts, ADR 229). A
  // camera re-render alone would not do: compiled, `commands.get(id)` is
  // kept for as long as the registry object is the same, and it always is.
  const commands = useRegistryView(useRegistries().commands);
  const pct = Math.round(camera.scale * 100);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-zoom-control
        className="pg-value"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 8px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--pg-border)",
          background: "transparent",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 12,
          color: "var(--pg-fg)",
        }}
      >
        {pct}%
        <Icon name="ui-chevron-down" size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} sideOffset={4}>
        {ZOOM_ITEMS.map(([label, id]) =>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
