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

// Navigator side panel.
//
// Scrollable column of page thumbnails. Click to fit-camera onto
// that page. Reuses the snapshot tier directly — no extra
// rendering. Per spec §8.5 the navigator's scroll position is
// independent of the canvas's, so users can browse pages while
// keeping their work in view.
//
// A long document shows its thumbnails as they come near the panel's
// view (one IntersectionObserver on a Fragment ref, ADR 240): the
// browser decodes what is shown, not every page of a 130-page document.

import { Fragment, ViewTransition } from "react";

import { useNearViewport } from "@paged-media/shell";
import type { Camera } from "@paged-media/client";
import type { PageId } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import { fitCamera, layoutPages, type PageRect } from "./layout";

const M = defineMessages("app.uiNavigator", {
  pages: "Pages",
  jumpTo: "Jump to page {page}",
  page: "Page {page}",
});

export interface NavigatorProps {
  pageIds: ReadonlyArray<PageId>;
  pageSizesPt: ReadonlyArray<readonly [number, number]>;
  /** Engine ADR 1011 — each page's top-left on the canvas, pt (absent:
   *  the pages stack). */
  pageOriginsPt?: ReadonlyArray<readonly [number, number]>;
  snapshots: ReadonlyMap<PageId, string>;
  viewportSize: readonly [number, number];
  onCameraChange: (cam: Camera) => void;
}

const THUMB_WIDTH_PX = 120;

export function Navigator(props: NavigatorProps) {
  const rects = layoutPages(props.pageSizesPt, props.pageOriginsPt);
  const strings = useStrings();
  const { observe: observeNear, has: isNear } = useNearViewport();

  const onJumpTo = (rect: PageRect) => {
    const [vw, vh] = props.viewportSize;
    if (vw < 10 || vh < 10) return;
    props.onCameraChange(fitCamera(vw, vh, rect));
  };

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        <strong>{strings.t(M.pages)}</strong>
        <span style={{ opacity: 0.6 }}>
          {props.snapshots.size}/{props.pageIds.length}
        </span>
      </header>
      <div style={listStyle}>
        <Fragment ref={observeNear}>
          {props.pageIds.map((id, i) => {
            const rect = rects[i];
            const url = isNear(id, i) ? props.snapshots.get(id) : undefined;
            return (
              <button
                key={id}
                data-near={id}
                type="button"
                onClick={() => onJumpTo(rect)}
                style={tileStyle}
                title={`${strings.t(M.jumpTo, { page: i + 1 })} (${id})`}
              >
                <div
                  style={{
                    width: THUMB_WIDTH_PX,
                    aspectRatio: `${rect.w} / ${rect.h}`,
                    border: "1px solid var(--chrome-border)",
                    background: "var(--muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--muted-fg)",
                    fontSize: 10,
                  }}
                >
                  {url ? (
                    // Never animates; inside it, a re-taken thumbnail (a
                    // transition) commits once decoded, not as a blank
                    // frame (ADR 240).
                    <ViewTransition default="none">
                      <img
                        src={url}
                        alt={strings.t(M.page, { page: i + 1 })}
                        style={{
                          width: "100%",
                          height: "100%",
                          display: "block",
                        }}
                        draggable={false}
                      />
                    </ViewTransition>
                  ) : (
                    "…"
                  )}
                </div>
                <span style={captionStyle}>{i + 1}</span>
              </button>
            );
          })}
        </Fragment>
      </div>
    </aside>
  );
}

const panelStyle: React.CSSProperties = {
  width: 160,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--chrome-border)",
  background: "var(--chrome-panel-bg)",
  flexShrink: 0,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 12px",
  borderBottom: "1px solid var(--chrome-border)",
  fontSize: 12,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 8,
};

const tileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
};

const captionStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--muted-fg)",
};
