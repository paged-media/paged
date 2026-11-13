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

// Progressive loading on the canvas (UXI-PRF-003; strategy §9.1; UX audit
// F-53, where a large document showed an empty dark rectangle for 15–21 s).
// The load's stages (`LoadingState.stage`, state/document-loader.ts) are
// shown where the document will appear, in words and real counts, never an
// invented percentage:
//
//   recognized  "Opening annual.idml…"
//   geometry    the pages' outlines, where each page will be, and "12 pages
//               · composing the first page…"
//   firstPaint  "First page ready · preparing 11 more…"
//   refining    "Preparing pages · 4 of 12"
//
// Ready removes it. The status is a polite live region, so a screen reader
// hears the stages too. It appears after a short delay (globals.css), so a
// small document that opens at once does not flash it.

import { useStrings, defineMessages } from "@paged-media/strings";
import { cameraMatrix } from "@paged-media/client";

import { useCamera } from "../../state/camera-context";
import {
  useOptionalDocument,
  type LoadingState,
} from "../../state/document-context";
import { layoutPageRects } from "./page-layout";

export const LOADING = defineMessages("shell.loading", {
  opening: "Opening {name}…",
  geometryOne: "1 page · composing it…",
  geometryMany: "{count} pages · composing the first page…",
  firstPaint: "First page ready · preparing {count} more…",
  refining: "Preparing pages · {done} of {count}",
  short: "Opening…",
  shortGeometry: "Composing…",
  shortRefining: "Preparing {done} of {count}",
});

type Strings = ReturnType<typeof useStrings>;

/** The words for a load's stage, long (the canvas) or short (the header). */
export function loadingWords(
  strings: Strings,
  loading: LoadingState,
  form: "long" | "short",
): string {
  const stage = loading.stage ?? "recognized";
  const count = loading.pageCount ?? 0;
  const done = loading.pagesReady ?? 0;
  if (form === "short") {
    if (stage === "recognized") return strings.t(LOADING.short);
    if (stage === "geometry") return strings.t(LOADING.shortGeometry);
    return strings.t(LOADING.shortRefining, { done, count });
  }
  switch (stage) {
    case "recognized":
      return strings.t(LOADING.opening, { name: loading.name });
    case "geometry":
      return count === 1
        ? strings.t(LOADING.geometryOne)
        : strings.t(LOADING.geometryMany, { count });
    case "firstPaint":
      return strings.t(LOADING.firstPaint, { count: count - done });
    case "refining":
      return strings.t(LOADING.refining, { done, count });
  }
}

/** The canvas's loading status; nothing once the document is ready. */
export function CanvasLoadingStatus() {
  const strings = useStrings();
  const doc = useOptionalDocument();
  const { camera } = useCamera();
  const loading = doc?.loading ?? null;
  if (!loading) return null;
  const stage = loading.stage ?? "recognized";
  const handle = doc?.handle ?? null;
  // Until the first page is composed, its place and its neighbours' are
  // outlined, so the canvas shows the document's shape, not nothing.
  const rects =
    stage === "geometry" && handle
      ? layoutPageRects(handle.pageSizesPt, handle.pageOriginsPt)
      : [];
  const [a, b, c, d, e, f] = cameraMatrix(camera);
  return (
    <div data-loading-status={stage} style={overlayStyle}>
      {rects.length > 0 && (
        <svg
          data-loading-placeholders
          aria-hidden
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0 }}
        >
          <g transform={`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}>
            {rects.map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                className="pg-page-placeholder"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </svg>
      )}
      <div role="status" aria-live="polite" className="pg-loading-pill">
        <span className="pg-loading-dot" aria-hidden />
        {loadingWords(strings, loading, "long")}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 5,
};
