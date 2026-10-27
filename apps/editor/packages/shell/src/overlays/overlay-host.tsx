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

import { isEnabled } from "../registries/types";
import { useMemo, type CSSProperties } from "react";

import { cameraMatrix, type Camera } from "@paged-media/client";
import type { PageId } from "@paged-media/client";

import type { OverlayPageRect, OverlayProps } from "../registries/overlay";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { useOptionalPaged } from "../state/paged-editor";

export interface OverlayHostProps {
  /** Current camera. */
  camera: Camera;
  /** Page rectangles in iteration order. The host turns this into
   *  the registry's page-id-keyed Map for contributions. */
  pageIds: ReadonlyArray<PageId>;
  pageRects: ReadonlyArray<OverlayPageRect>;
  /** Host SVG size in CSS px. */
  width: number;
  height: number;
}

/**
 * Mounts every registered overlay contribution inside a shared SVG
 * sized to the host (`width` × `height`) and transformed by the
 * current camera. Re-renders on contribution registration changes
 * so a bundle disposing its overlay disappears in the next tick.
 *
 * Contributions render their own subtree; the host only provides:
 *   - z-order sorting (default 100, ties break on insertion order)
 *   - the shared `<svg>` + camera-transform `<g>` wrapper
 *   - the standard `OverlayProps` (paged, camera, pageRects Map)
 */
export function OverlayHost(props: OverlayHostProps) {
  // A view of the overlay registry (state/live.ts): the sort follows a
  // contribution coming or going.
  const registries = useRegistries();
  const overlays = useRegistryView(registries.overlays);
  const features = useRegistryView(registries.features);
  const paged = useOptionalPaged();
  // An overlay draws while its `when` holds and the editor offers it (a
  // feature, `overlay:<id>`); `when` was declared and never read before.
  const sorted = overlays
    .list()
    .filter(
      (c) => features.allows("overlay", c.id) && isEnabled(c.when, () => paged),
    )
    .sort((a, b) => (a.z ?? 100) - (b.z ?? 100));

  // eslint-disable-next-line no-restricted-syntax -- handed to components that compare it (ADR 229)
  const pageRects = useMemo<ReadonlyMap<PageId, OverlayPageRect>>(() => {
    const map = new Map<PageId, OverlayPageRect>();
    const n = Math.min(props.pageIds.length, props.pageRects.length);
    for (let i = 0; i < n; i++) {
      map.set(props.pageIds[i], props.pageRects[i]);
    }
    return map;
  }, [props.pageIds, props.pageRects]);

  // v77 (editor ADR 287) — the camera's rotation (Rotate View) turns the
  // overlays with the canvas.
  const transform = `matrix(${cameraMatrix(props.camera).join(", ")})`;
  const overlayProps: OverlayProps = { paged, camera: props.camera, pageRects };

  return (
    <svg width={props.width} height={props.height} style={overlayStyle}>
      <g transform={transform}>
        {sorted.map((c) => {
          const Render = c.render;
          return <Render key={c.id} {...overlayProps} />;
        })}
      </g>
    </svg>
  );
}

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  display: "block",
};
