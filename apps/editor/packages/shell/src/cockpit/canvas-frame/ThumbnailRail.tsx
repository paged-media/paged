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

// Cockpit — the bottom page-thumbnail filmstrip (kit canvas.jsx
// ThumbnailRail). REAL: live page snapshots grouped into spreads,
// labels are page ranges, click navigates (the app supplies the
// camera-fit via `onNavigate` — the layout math lives app-side).
//
// The selection ring is one shared element (ADR 240): picking another
// spread is a view transition in which the ring moves from the spread it
// was on to the new one, in the direction of the move. Spreads show their
// thumbnails as they come near the strip's view (one observer on a
// Fragment ref).

import { useStrings } from "@paged-media/strings";
import { COCKPIT, PAGES } from "../messages";
import { Fragment, ViewTransition, useState } from "react";

import { Icon } from "../../icons";
import { useDocument } from "../../state/document-context";
import { useCollection } from "../../catalog/use-collection";
import type { SpreadSummary } from "@paged-media/client";
import { groupSpreads } from "../spread-grouping";
import { navigateToPages } from "../cockpit-navigation";
import { IconButton } from "@paged-media/panel-kit";
import { useNearViewport } from "../../state/live";
import {
  SHARE_MOVE,
  directionOf,
  transitionWith,
} from "../../view-transitions";

export function ThumbnailRail() {
  const strings = useStrings();
  const { handle, snapshots } = useDocument();
  const spreads = useCollection<SpreadSummary>("spreads");
  const [selected, setSelected] = useState<string | null>(null);
  const { observe: observeNear, has: isNear } = useNearViewport();

  const entries = handle ? groupSpreads(handle.pageIds, spreads) : [];

  const scrollBy = (dir: -1 | 1) => {
    const el = document.querySelector<HTMLElement>("[data-thumbnail-strip]");
    el?.scrollBy({ left: dir * 260, behavior: "smooth" });
  };

  return (
    <div
      data-thumbnail-rail
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 104,
        padding: "0 14px",
        background: "var(--chrome-panel-bg)",
        borderTop: "1px solid var(--chrome-border)",
        flexShrink: 0,
      }}
    >
      <RailArrow
        name="ui-chevron-left"
        label={strings.t(COCKPIT.scrollPagesLeft)}
        onClick={() => scrollBy(-1)}
      />
      <div
        data-thumbnail-strip
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 14,
          overflowX: "auto",
          height: "100%",
          paddingTop: 12,
          scrollbarWidth: "none",
        }}
      >
        {entries.length === 0 ? (
          <span className="pg-ui-xs" style={{ opacity: 0.6 }}>
            {strings.t(COCKPIT.noSpreads)}
          </span>
        ) : (
          <Fragment ref={observeNear}>
            {entries.map((e, index) => {
              const sel = selected === e.key;
              return (
                <button
                  key={e.key}
                  type="button"
                  data-near={e.key}
                  data-thumbnail-spread={e.key}
                  data-selected={sel || undefined}
                  onClick={() => {
                    const from = entries.findIndex((x) => x.key === selected);
                    transitionWith(directionOf(from, index), () =>
                      setSelected(e.key),
                    );
                    navigateToPages(e.pageIndices);
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    flexShrink: 0,
                    padding: 0,
                  }}
                >
                  <span
                    style={{
                      position: "relative",
                      display: "flex",
                      gap: 1,
                      border: "1px solid var(--pg-border)",
                      borderRadius: 2,
                      background: "var(--pg-bg)",
                    }}
                  >
                    {sel && (
                      <ViewTransition
                        name="filmstrip-selection"
                        share={SHARE_MOVE}
                        default="none"
                      >
                        <span
                          aria-hidden
                          data-thumbnail-selection
                          style={{
                            position: "absolute",
                            inset: -3,
                            border: "2px solid var(--pg-primary)",
                            borderRadius: 3,
                            pointerEvents: "none",
                          }}
                        />
                      </ViewTransition>
                    )}
                    {e.pageIndices.slice(0, 2).map((i) => {
                      const url =
                        handle && isNear(e.key, index)
                          ? snapshots.get(handle.pageIds[i])
                          : undefined;
                      return url ? (
                        <img
                          key={i}
                          src={url}
                          alt=""
                          draggable={false}
                          style={{
                            width: 33,
                            height: 48,
                            objectFit: "cover",
                            display: "block",
                          }}
                        />
                      ) : (
                        <span
                          key={i}
                          style={{
                            width: 33,
                            height: 48,
                            background: "var(--pg-muted)",
                            display: "block",
                          }}
                        />
                      );
                    })}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 10.5,
                      color: sel ? "var(--pg-primary)" : "var(--pg-muted-fg)",
                      fontWeight: sel ? 600 : 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.name === strings.t(PAGES.cover) ? e.name : e.range}
                  </span>
                </button>
              );
            })}
          </Fragment>
        )}
      </div>
      <RailArrow
        name="ui-chevron-right"
        label={strings.t(COCKPIT.scrollPagesRight)}
        onClick={() => scrollBy(1)}
      />
    </div>
  );
}

function RailArrow({
  name,
  label,
  onClick,
}: {
  name: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: "50%",
        border: "1px solid var(--pg-border)",
        background: "var(--pg-bg)",
        color: "var(--chrome-icon)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon name={name} size={15} />
    </IconButton>
  );
}
