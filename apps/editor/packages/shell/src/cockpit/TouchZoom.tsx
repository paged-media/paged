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

// Zoom buttons over the canvas of a fill shape on a touch screen (editor
// ADR 293): zoom out, fit the page, zoom in, each a 44 px target. They run
// the View menu's own commands, so they zoom as the keys do; a pinch zooms
// the same camera. A desktop editor never renders them.

import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import { useRegistryView } from "../state/live";
import { useRegistries } from "../state/registries-context";
import { TOUCH_TARGET_PX } from "../state/compact";
import { ZOOM } from "../chrome/messages";
import { COCKPIT } from "./messages";

const BUTTONS: ReadonlyArray<readonly [string, string, string]> = [
  ["paged.view.zoomOut", ZOOM.zoomOut, "ui-minus"],
  ["paged.view.fitPage", ZOOM.fitPage, "ui-page"],
  ["paged.view.zoomIn", ZOOM.zoomIn, "ui-plus"],
];

export function TouchZoomControls() {
  const strings = useStrings();
  const commands = useRegistryView(useRegistries().commands);
  return (
    <div
      data-touch-zoom
      role="toolbar"
      aria-label={strings.t(COCKPIT.zoom)}
      style={{
        position: "absolute",
        right: "var(--space-3)",
        bottom: "var(--space-3)",
        zIndex: 20,
        display: "flex",
        gap: "var(--space-1)",
        padding: "var(--space-1)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--chrome-border)",
        background: "var(--chrome-panel-bg)",
        boxShadow: "var(--shadow-2)",
      }}
    >
      {BUTTONS.map(([id, label, icon]) =>
        commands.get(id) ? (
          <button
            key={id}
            type="button"
            data-touch-zoom-command={id}
            aria-label={strings.t(label)}
            title={strings.t(label)}
            onClick={() => void commands.invoke(id)}
            style={{
              width: TOUCH_TARGET_PX,
              height: TOUCH_TARGET_PX,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: "var(--radius-md)",
              background: "transparent",
              color: "var(--pg-fg)",
              cursor: "pointer",
            }}
          >
            <Icon name={icon} size={20} />
          </button>
        ) : null,
      )}
    </div>
  );
}
