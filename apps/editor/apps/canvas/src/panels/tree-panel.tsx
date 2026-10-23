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

// Inspector P1 — scene-tree outline panel. Click a row to select
// the corresponding frame; selection mirrors in both directions
// because the panel reads `useSelection()` for the highlight.

import { useEffect, useState } from "react";

import { useCanvasClient, useSelection } from "@paged-media/shell";

import type { ElementId, SceneTreeNode } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.treePanel", {
  noDocument: "No document loaded.",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PanelProps = any;

export function TreePanel(_: PanelProps) {
  const strings = useStrings();
  const client = useCanvasClient();
  const { elementSelection, setElementSelection, setElementGeometry } =
    useSelection();
  const [roots, setRoots] = useState<SceneTreeNode[]>([]);

  // Re-fetch on document load + any structural mutation. Lightweight
  // payload; no need for delta-fetching in v1.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void client
        .sceneTree()
        .then((next) => {
          if (!cancelled) setRoots(next);
        })
        .catch(() => {
          if (!cancelled) setRoots([]);
        });
    };
    refresh();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "documentLoaded" ||
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      ) {
        refresh();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [client]);

  const selectedKeys = selectionKeys(elementSelection);

  const onPick = (id: ElementId) => {
    void client
      .setElementSelection([id], "replace")
      .then((ids) => {
        setElementSelection(ids);
        return client.elementGeometry(ids);
      })
      .then(setElementGeometry)
      .catch(() => {});
  };

  if (roots.length === 0) {
    return (
      <div className="p-3 text-sm text-muted-foreground" data-tree="empty">
        {strings.t(M.noDocument)}
      </div>
    );
  }

  return (
    <div className="p-2 text-sm" data-tree="ready">
      <ul className="space-y-0.5">
        {roots.map((node, i) => (
          <TreeRow
            key={i}
            node={node}
            depth={0}
            selectedKeys={selectedKeys}
            onPick={onPick}
          />
        ))}
      </ul>
    </div>
  );
}

function TreeRow(props: {
  node: SceneTreeNode;
  depth: number;
  selectedKeys: ReadonlySet<string>;
  onPick: (id: ElementId) => void;
}) {
  const { node, depth, selectedKeys, onPick } = props;
  const key = node.id ? `${node.id.kind}:${node.id.id}` : null;
  const isSelected = key !== null && selectedKeys.has(key);
  const indent = { paddingLeft: 8 + depth * 12 } as const;
  return (
    <li>
      <button
        type="button"
        className={`w-full text-left px-1 py-0.5 rounded hover:bg-muted/60 ${
          isSelected ? "bg-muted text-foreground" : "text-muted-foreground"
        }`}
        style={indent}
        data-tree-row={key ?? node.kind}
        onClick={() => node.id && onPick(node.id)}
        disabled={!node.id}
      >
        <span className="text-xs uppercase opacity-70 mr-2">{node.kind}</span>
        <span>{node.label}</span>
      </button>
      {(node.children?.length ?? 0) > 0 && (
        <ul className="space-y-0.5">
          {(node.children ?? []).map((child, i) => (
            <TreeRow
              key={i}
              node={child}
              depth={depth + 1}
              selectedKeys={selectedKeys}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Every selected item's key (PN-108): a multi-selection highlights each
// of its rows, as InDesign's Layers panel marks every selected object.
function selectionKeys(sel: ElementId[]): ReadonlySet<string> {
  return new Set(sel.map((id) => `${id.kind}:${id.id}`));
}
