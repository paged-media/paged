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

// The LAYERS panel — the `panels/layers.panel.json` prototype made real, as
// the expert-leaf React panel that prototype's own comment prescribes (the v1
// schema has no list widget — B-01's honest limit). A live, ordered layer
// list over `documentCollection("layers")` with per-row ops through the wire
// mutations that have existed all along: layerSetVisible / layerSetLocked /
// layerSetPrintable / layerSetName / layerMove / layerInsert / layerRemove.
// Refreshes on `host.document.onDidChange` (undo/redo and foreign edits
// included) — no polling.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

/** Mirror of the wire `LayerSummary` collection row. */
interface LayerRow {
  selfId: string;
  name: string | null;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  z: number;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 0",
  font: "12px var(--font-sans, sans-serif)",
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 2px",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg, currentColor)",
};

export function makeLayersPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [layers, setLayers] = React.useState<LayerRow[]>([]);
    const [renaming, setRenaming] = React.useState<string | null>(null);
    const [draft, setDraft] = React.useState("");

    const reload = React.useCallback(async () => {
      try {
        const rows = await host.document.collection<LayerRow>("layers");
        // Top-most first (highest z at the top, the DTP convention).
        setLayers([...rows].sort((a, b) => b.z - a.z));
      } catch {
        setLayers([]);
      }
    }, []);

    React.useEffect(() => {
      void reload();
      const sub = host.document.onDidChange(() => void reload());
      return () => sub.dispose();
    }, [reload]);

    const mutate = async (
      mutation: Parameters<BundleHost["document"]["mutate"]>[0],
    ) => {
      try {
        await host.document.mutate(mutation);
      } catch (e) {
        host.log.warn(`layers: ${String(e)}`);
      }
      void reload();
    };

    const move = (layer: LayerRow, dir: 1 | -1) => {
      // The list renders top-first; "up" means a HIGHER z = a higher
      // collection index. layerMove takes the target collection index.
      const byZ = [...layers].sort((a, b) => a.z - b.z);
      const idx = byZ.findIndex((l) => l.selfId === layer.selfId);
      const next = idx + dir;
      if (next < 0 || next >= byZ.length) return;
      void mutate({
        op: "layerMove",
        args: { layerId: layer.selfId, newIndex: next },
      });
    };

    return (
      <div style={{ padding: 12 }} data-draw-layers-panel={layers.length}>
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span
            style={{
              font: "11px var(--font-sans, sans-serif)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              opacity: 0.65,
            }}
          >
            Layers ({layers.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title="New layer (top)"
            data-draw-layer-add
            onClick={() =>
              void mutate({
                op: "layerInsert",
                args: { position: layers.length, name: `Layer ${layers.length + 1}` },
              })
            }
          >
            ＋
          </button>
        </div>
        {layers.length === 0 && (
          <div style={{ opacity: 0.6, font: "12px var(--font-sans, sans-serif)" }}>
            No document open (or it has no layers).
          </div>
        )}
        {layers.map((l) => (
          <div key={l.selfId} style={rowStyle} data-draw-layer={l.selfId}>
            <button
              type="button"
              style={{ ...iconBtn, opacity: l.visible ? 1 : 0.35 }}
              title={l.visible ? "Hide layer" : "Show layer"}
              data-draw-layer-visible={l.visible}
              onClick={() =>
                void mutate({
                  op: "layerSetVisible",
                  args: { layerId: l.selfId, visible: !l.visible },
                })
              }
            >
              👁
            </button>
            <button
              type="button"
              style={{ ...iconBtn, opacity: l.locked ? 1 : 0.35 }}
              title={l.locked ? "Unlock layer" : "Lock layer"}
              data-draw-layer-locked={l.locked}
              onClick={() =>
                void mutate({
                  op: "layerSetLocked",
                  args: { layerId: l.selfId, locked: !l.locked },
                })
              }
            >
              🔒
            </button>
            <button
              type="button"
              style={{ ...iconBtn, opacity: l.printable ? 1 : 0.35 }}
              title={l.printable ? "Non-printing" : "Printing"}
              onClick={() =>
                void mutate({
                  op: "layerSetPrintable",
                  args: { layerId: l.selfId, printable: !l.printable },
                })
              }
            >
              🖶
            </button>
            {renaming === l.selfId ? (
              <input
                autoFocus
                value={draft}
                data-draw-layer-rename
                style={{ flex: 1, minWidth: 0, font: "12px var(--font-sans, sans-serif)" }}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  setRenaming(null);
                  if (draft && draft !== l.name) {
                    void mutate({
                      op: "layerSetName",
                      args: { layerId: l.selfId, name: draft },
                    });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title="Double-click to rename"
                onDoubleClick={() => {
                  setRenaming(l.selfId);
                  setDraft(l.name ?? "");
                }}
              >
                {l.name ?? l.selfId}
              </span>
            )}
            <button
              type="button"
              style={iconBtn}
              title="Move up"
              onClick={() => move(l, 1)}
            >
              ▲
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Move down"
              onClick={() => move(l, -1)}
            >
              ▼
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Delete layer"
              data-draw-layer-remove
              onClick={() =>
                void mutate({ op: "layerRemove", args: { layerId: l.selfId } })
              }
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    );
  };
  return { title: "Layers (draw)", component: Component, defaultDock: "right" };
}
