/*
 * This file is part of paged (https://paged.media).
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

// The SmartArt text pane (slide W4): the selected diagram's points as an
// outline, one field each, indented by level, as PowerPoint's Text Pane
// lists them. A field's text is written when it loses focus or on Enter
// (Shift+Enter starts a new paragraph of the point), one undo step each;
// Escape puts back what the document holds. A point no shape of the
// drawing shows is listed, read-only: there is no layout engine to give it
// a shape.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { SMARTART } from "../messages.js";
import type { SmartArtPoint, SmartArtStore } from "../smartart.js";

interface FieldProps {
  point: SmartArtPoint;
  store: SmartArtStore;
  label: string;
}

/** One point's field. */
function PointField({ point, store, label }: FieldProps) {
  // The field is keyed by the point's text, so a change underneath (undo, a
  // canvas edit) mounts it again with the new text.
  const [draft, setDraft] = React.useState(point.text);
  const commit = () => {
    if (draft !== point.text) void store.setText(point.id, draft);
  };
  const rows = Math.max(1, draft.split("\n").length);
  return (
    <textarea
      data-smartart-point={point.id}
      aria-label={label}
      value={draft}
      rows={rows}
      readOnly={!point.shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(point.text);
        }
      }}
      style={{
        marginLeft: point.depth * 16,
        resize: "none",
        font: "inherit",
        fontSize: 13,
        opacity: point.shown ? 1 : 0.6,
      }}
    />
  );
}

export function makeSmartArtPanel(
  _host: BundleHost,
  store: SmartArtStore,
): React.ComponentType<PanelProps> {
  const subscribe = (l: () => void) => store.subscribe(l);
  const snapshot = () => store.current();
  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const art = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    if (!art) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-smartart-panel="empty"
        >
          {t(SMARTART.empty)}
        </div>
      );
    }
    return (
      <div
        data-smartart-panel="ready"
        style={{
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ fontSize: 11, opacity: 0.7 }}>{t(SMARTART.heading)}</div>
        {art.points.map((p, i) => (
          <PointField
            key={`${p.id}\u0000${p.text}`}
            point={p}
            store={store}
            label={t(SMARTART.point, { number: i + 1 })}
          />
        ))}
        <div style={{ fontSize: 11, opacity: 0.6 }}>{t(SMARTART.hint)}</div>
      </div>
    );
  };
  return Component;
}
