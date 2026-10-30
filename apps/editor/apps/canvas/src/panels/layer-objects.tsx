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

// WP4.6 — the Layers panel's OBJECTS: each layer with the page items on
// it, groups nested under their layer with expand / collapse (Illustrator's
// sublayers, InDesign's disclosure triangles), front at top.
//
//   · a row click selects the item (the canvas selection, as a click on
//     the canvas leaves it);
//   · Locate object expands the tree down to the selection and scrolls its
//     row into view;
//   · the target circle targets the item for the Appearance / Effects
//     panel (selects it and shows the panel); it is FILLED when the item
//     has a non-default appearance (opacity, a blend mode, an effect);
//   · a drag reorders: onto an item in the same container it takes that
//     item's stacking slot (`reorderElement`, absolute index) — and its
//     layer, when the target is on another one (`itemLayer` on every
//     leaf, IDML's rule: a group has no layer, its members do); onto a
//     layer row it moves to that layer. One batch, one undo step.
//
// WHY THIS IS HOST REACT AND NOT THE SCHEMA LIST. The layer list above is
// bound to the `layers` COLLECTION so an edit context can answer it
// (ADR 023); page items are not a collection the engine serves per layer.
// The read is the scene tree (stacking order, groups) joined with each
// item's `itemLayer` and appearance properties, and it is drawn only while
// core answers the layer list (a provider's rows are its own realm).
//
// LAYER COLOURS. InDesign gives each new layer the next colour of a fixed
// sequence; the document's own `LayerColor` is not on the wire
// (`LayerSummary` has no colour), so the chip shows that default sequence
// by the layer's position, and says so in its title.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  Icon,
  useCanvasClient,
  useRegistries,
  useRegistryView,
  useSelection,
} from "@paged-media/shell";
import type {
  ElementId,
  LayerSummary,
  Mutation,
  PropertyEntry,
  SceneTreeNode,
} from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import { PAGED_ELEMENTS_MIME } from "../asset-export/model";

const M = defineMessages("app.layerObjects", {
  objects: "Objects",
  locate: "Locate object",
  target: "Target for appearance",
  hasAppearance: "Has an appearance",
  expand: "Expand",
  collapse: "Collapse",
  empty: "No objects",
  layerColour: "Layer colour (InDesign's default sequence)",
  loading: "Reading objects…",
  noLayer: "No layer",
});

/** InDesign's layer colour sequence (Light Blue, Red, Green, Blue,
 *  Yellow, Magenta, Cyan, Gray, Black, Orange, Dark Green, Teal, Tan,
 *  Brown, Violet, Gold). Content colours, not chrome: literal by design. */
export const LAYER_COLOURS = [
  "#4f99ff",
  "#ff0000",
  "#4fff4f",
  "#0000ff",
  "#ffff4f",
  "#ff4fff",
  "#00ffff",
  "#808080",
  "#000000",
  "#ff6600",
  "#006600",
  "#006666",
  "#cc9966",
  "#993300",
  "#990099",
  "#ff9900",
] as const;

export function layerColour(index: number): string {
  const n = LAYER_COLOURS.length;
  return LAYER_COLOURS[((index % n) + n) % n]!;
}

/** One page item as the tree shows it. */
export interface ObjectNode {
  id: ElementId;
  key: string;
  label: string;
  kind: string;
  /** The container's key (`page:<n>` for a spread's top level, the
   *  group's key inside one): reorder works within one. */
  parent: string;
  /** Its slot in the container's stacking list (0 = backmost). */
  slot: number;
  /** The layer it is on (a group: its first member's). */
  layerId: string | null;
  appearance: boolean;
  /** Front first. */
  children: ObjectNode[];
}

export interface LayerBranch {
  layer: LayerSummary;
  colour: string;
  /** The layer's top-level items, front first. */
  items: ObjectNode[];
}

export const elementKey = (id: ElementId): string =>
  `${id.kind}:${String((id as { id?: unknown }).id)}`;

/** What one item's properties say: its layer, and whether it carries a
 *  non-default appearance (opacity below 100 %, a blend mode, any
 *  effect switched on). */
export function readItem(entries: ReadonlyArray<PropertyEntry> | null): {
  layerId: string | null;
  appearance: boolean;
} {
  let layerId: string | null = null;
  let appearance = false;
  for (const e of entries ?? []) {
    const v = e.value as { type?: string; value?: unknown } | null | undefined;
    if (!v) continue;
    const path = e.path as string;
    if (path === "itemLayer" && v.type === "text") {
      layerId = (v.value as string) || null;
    } else if (path === "frameOpacity" && typeof v.value === "number") {
      if (v.value < 100) appearance = true;
    } else if (
      path.endsWith("BlendMode") &&
      v.type === "text" &&
      v.value &&
      v.value !== "Normal"
    ) {
      // Only the object's own blend modes; an effect's blend mode
      // (frameDropShadowBlendMode, …) means nothing while it is off.
      if (path === "frameBlendMode" || path === "frameContentBlendMode") {
        appearance = true;
      }
    } else if (
      (path.endsWith("Enabled") || path === "frameDropShadow") &&
      v.type === "bool" &&
      v.value === true
    ) {
      appearance = true;
    }
  }
  return { layerId, appearance };
}

type Facts = ReadonlyMap<
  string,
  { layerId: string | null; appearance: boolean }
>;

function toNode(
  n: SceneTreeNode,
  parent: string,
  slot: number,
  facts: Facts,
): ObjectNode | null {
  if (!n.id) return null;
  const key = elementKey(n.id);
  const kids = (n.children ?? [])
    .map((c, i) => toNode(c, key, i, facts))
    .filter((c): c is ObjectNode => c !== null);
  const own = facts.get(key);
  const layerId = own?.layerId ?? kids.find((c) => c.layerId)?.layerId ?? null;
  return {
    id: n.id,
    key,
    label: n.label,
    kind: n.kind,
    parent,
    slot,
    layerId,
    appearance: own?.appearance ?? false,
    children: kids.reverse(),
  };
}

/** Every item node of the scene tree with an id, depth first (what the
 *  property reads are asked for). */
export function itemIds(roots: ReadonlyArray<SceneTreeNode>): ElementId[] {
  const out: ElementId[] = [];
  const walk = (n: SceneTreeNode) => {
    if (n.id) out.push(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  roots.forEach(walk);
  return out;
}

/** The stand-in branch of a document with no `<Layer>` at all (a blank
 *  document the engine minted): its items are still listed. */
export const NO_LAYER_ID = "";

/** The layers, front first, each with its items front first. An item on
 *  a layer the list does not have (or on none) is shown on the backmost
 *  layer, the one InDesign files layer-less items on. A document without
 *  layers gets one stand-in branch (`NO_LAYER_ID`). */
export function buildLayerTree(
  roots: ReadonlyArray<SceneTreeNode>,
  layers: ReadonlyArray<LayerSummary>,
  facts: Facts,
): LayerBranch[] {
  const ordered: LayerSummary[] =
    layers.length > 0
      ? [...layers].sort((a, b) => a.z - b.z)
      : [
          {
            selfId: NO_LAYER_ID,
            name: null,
            visible: true,
            locked: false,
            printable: true,
            z: 0,
          },
        ];
  const back = ordered[0]?.selfId ?? null;
  const known = new Set(ordered.map((l) => l.selfId));
  const byLayer = new Map<string, ObjectNode[]>();
  let pageNo = 0;
  const visitPage = (page: SceneTreeNode) => {
    const container = `page:${pageNo++}`;
    (page.children ?? []).forEach((c, i) => {
      const node = toNode(c, container, i, facts);
      if (!node) return;
      const on = node.layerId && known.has(node.layerId) ? node.layerId : back;
      if (on === null) return;
      const list = byLayer.get(on) ?? [];
      list.push(node);
      byLayer.set(on, list);
    });
  };
  for (const spread of roots) {
    if (spread.kind === "Page") visitPage(spread);
    for (const page of spread.children ?? []) {
      if (page.kind === "Page") visitPage(page);
    }
  }
  return ordered
    .map((layer, i) => ({
      layer,
      colour: layerColour(i),
      // Pages in order, each page's items front first.
      items: (byLayer.get(layer.selfId) ?? []).slice().reverse(),
    }))
    .reverse();
}

/** The keys from the root down to `key` (exclusive), layer row first. */
export function pathTo(
  tree: ReadonlyArray<LayerBranch>,
  key: string,
): string[] | null {
  const walk = (nodes: ObjectNode[], trail: string[]): string[] | null => {
    for (const n of nodes) {
      if (n.key === key) return trail;
      const hit = walk(n.children, [...trail, n.key]);
      if (hit) return hit;
    }
    return null;
  };
  for (const b of tree) {
    const hit = walk(b.items, [`layer:${b.layer.selfId}`]);
    if (hit) return hit;
  }
  return null;
}

function leavesOf(n: ObjectNode): ElementId[] {
  return n.children.length === 0 && n.kind !== "Group"
    ? [n.id]
    : n.children.flatMap(leavesOf);
}

const setLayer = (id: ElementId, layerId: string): Mutation =>
  ({
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "itemLayer",
      value: { type: "text", value: layerId },
    },
  }) as Mutation;

/** The mutation a drop makes, or null for a drop that means nothing (onto
 *  itself, or into a different container — the engine moves an item
 *  within its own stacking list only). */
export function dropMutation(
  dragged: ObjectNode,
  target:
    { kind: "layer"; layerId: string } | { kind: "item"; node: ObjectNode },
): Mutation | null {
  const ops: Mutation[] = [];
  const toLayer =
    target.kind === "layer" ? target.layerId : target.node.layerId;
  // The stand-in branch is no layer to move anything to.
  if (toLayer && toLayer !== dragged.layerId) {
    for (const leaf of leavesOf(dragged)) ops.push(setLayer(leaf, toLayer));
  }
  if (target.kind === "item") {
    const t = target.node;
    if (t.key === dragged.key || t.parent !== dragged.parent) return null;
    ops.push({
      op: "reorderElement",
      args: { elementId: dragged.id, to: { index: t.slot } },
    } as Mutation);
  }
  if (ops.length === 0) return null;
  return ops.length === 1
    ? ops[0]!
    : ({ op: "batch", args: { ops } } as Mutation);
}

/** The scene tree joined with each item's facts, re-read after every edit
 *  (debounced: a burst of edits costs one read). */
function useObjectTree(enabled: boolean) {
  const client = useCanvasClient();
  const [state, setState] = useState<{
    roots: SceneTreeNode[];
    facts: Facts;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const roots = await client.sceneTree();
      const ids = itemIds(roots);
      const entries = await Promise.all(
        ids.map((id) => client.elementProperties(id).catch(() => null)),
      );
      const facts = new Map<
        string,
        { layerId: string | null; appearance: boolean }
      >();
      ids.forEach((id, i) =>
        facts.set(elementKey(id), readItem(entries[i]?.entries ?? null)),
      );
      return { roots, facts };
    };
    const refresh = () => {
      void read()
        .then((next) => {
          if (live) setState(next);
        })
        .catch(() => {});
    };
    refresh();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "documentLoaded" ||
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "gestureCommitted"
      ) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 60);
      }
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [client, enabled]);
  return state;
}

export interface LayerObjectsProps {
  layers: ReadonlyArray<LayerSummary>;
  /** Writes through the panel's provider-first mutate (one undo step). */
  run: (mutation: Mutation, what: string) => Promise<void>;
}

export function LayerObjects({ layers, run }: LayerObjectsProps) {
  const strings = useStrings();
  const client = useCanvasClient();
  const registries = useRegistries();
  const panels = useRegistryView(registries.panels);
  const { elementSelection, setElementSelection, setElementGeometry } =
    useSelection();
  const data = useObjectTree(true);
  // Collapsed groups are the default; layers start open.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [closedLayers, setClosedLayers] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [locateKey, setLocateKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tree = data ? buildLayerTree(data.roots, layers, data.facts) : null;
  const selected = new Set(elementSelection.map(elementKey));

  // Locate: once the expanded row is on screen, scroll it into view.
  useLayoutEffect(() => {
    if (!locateKey) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-object-row="${CSS.escape(locateKey)}"]`,
    );
    if (!row) return;
    row.scrollIntoView?.({ block: "nearest" });
    row.setAttribute("data-located", "");
    setLocateKey(null);
    // `open` is in the list: the row renders once its ancestors are open.
  }, [locateKey, open, closedLayers]);

  const find = (key: string): ObjectNode | null => {
    const walk = (nodes: ObjectNode[]): ObjectNode | null => {
      for (const n of nodes) {
        if (n.key === key) return n;
        const hit = walk(n.children);
        if (hit) return hit;
      }
      return null;
    };
    for (const b of tree ?? []) {
      const hit = walk(b.items);
      if (hit) return hit;
    }
    return null;
  };

  const select = (id: ElementId) =>
    client
      .setElementSelection([id], "replace")
      .then(async (ids) => {
        setElementSelection(ids);
        setElementGeometry(await client.elementGeometry(ids));
      })
      .catch(() => {});

  const onLocate = () => {
    if (!tree || elementSelection.length === 0) return;
    const key = elementKey(elementSelection[0]!);
    const trail = pathTo(tree, key);
    if (!trail) return;
    const layerKey = trail[0]!.slice("layer:".length);
    setClosedLayers((prev) => {
      const next = new Set(prev);
      next.delete(layerKey);
      return next;
    });
    setOpen((prev) => new Set([...prev, ...trail.slice(1)]));
    setLocateKey(key);
  };

  const onTarget = (n: ObjectNode) => {
    void select(n.id).then(() => {
      const panel = panels.get("paged.appearance")
        ? "paged.appearance"
        : "paged.effects";
      void registries.commands.invoke(`paged.panel.show.${panel}`);
    });
  };

  const onDrop = (
    target:
      { kind: "layer"; layerId: string } | { kind: "item"; node: ObjectNode },
  ) => {
    const dragged = dragKey ? find(dragKey) : null;
    setDragKey(null);
    if (!dragged) return;
    const m = dropMutation(dragged, target);
    if (m) void run(m, "objectDrop");
  };

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNode = (n: ObjectNode, depth: number, colour: string) => {
    const isGroup = n.kind === "Group";
    const expanded = open.has(n.key);
    return (
      <div key={n.key} role="none">
        <div
          role="treeitem"
          aria-selected={selected.has(n.key)}
          aria-expanded={isGroup ? expanded : undefined}
          data-object-row={n.key}
          data-object-kind={n.kind}
          data-selected={selected.has(n.key) ? "" : undefined}
          draggable
          className="flex h-6 cursor-default items-center gap-1 pr-1 hover:bg-muted/60 data-[selected]:bg-muted"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => void select(n.id)}
          onDragStart={(e) => {
            e.dataTransfer?.setData("text/plain", n.key);
            // Editor ADR 288 — the Asset Export panel collects a row
            // dropped on it: the item's id rides as JSON.
            e.dataTransfer?.setData(
              PAGED_ELEMENTS_MIME,
              JSON.stringify([n.id]),
            );
            setDragKey(n.key);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onDrop({ kind: "item", node: n });
          }}
        >
          {isGroup ? (
            <button
              type="button"
              className="flex h-4 w-4 items-center justify-center"
              aria-label={strings.t(expanded ? M.collapse : M.expand)}
              data-object-twisty={n.key}
              onClick={(e) => {
                e.stopPropagation();
                toggle(n.key);
              }}
            >
              <Icon
                name={expanded ? "ui-chevron-down" : "ui-chevron-right"}
                size={11}
              />
            </button>
          ) : (
            <span className="inline-block w-4" />
          )}
          <span
            className="inline-block h-2 w-0.5 shrink-0"
            style={{ background: colour }}
            data-color-preview
          />
          <span className="min-w-0 flex-1 truncate text-xs">{n.label}</span>
          <button
            type="button"
            className="flex h-4 w-4 items-center justify-center"
            aria-label={strings.t(M.target)}
            title={
              n.appearance
                ? `${strings.t(M.target)} · ${strings.t(M.hasAppearance)}`
                : strings.t(M.target)
            }
            data-object-target={n.key}
            data-appearance={n.appearance ? "filled" : "empty"}
            onClick={(e) => {
              e.stopPropagation();
              onTarget(n);
            }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full border border-current"
              style={{ background: n.appearance ? "currentColor" : "none" }}
            />
          </button>
        </div>
        {isGroup &&
          expanded &&
          n.children.map((c) => renderNode(c, depth + 1, colour))}
      </div>
    );
  };

  return (
    <div
      className="flex flex-col"
      data-layer-objects={tree ? "ready" : "loading"}
    >
      <div className="flex items-center justify-between border-b border-input px-2 py-1">
        <span className="pg-ui-xs text-muted-foreground">
          {strings.t(M.objects)}
        </span>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted/60 disabled:opacity-40"
          aria-label={strings.t(M.locate)}
          title={strings.t(M.locate)}
          data-action="locate-object"
          disabled={elementSelection.length === 0}
          onClick={onLocate}
        >
          <Icon name="ui-target" size={13} />
        </button>
      </div>
      <div
        ref={listRef}
        role="tree"
        aria-label={strings.t(M.objects)}
        className="max-h-[40vh] overflow-auto py-0.5"
      >
        {!tree && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {strings.t(M.loading)}
          </p>
        )}
        {tree?.map((b) => {
          const key = b.layer.selfId;
          const shut = closedLayers.has(key);
          return (
            <div key={key} role="none">
              <div
                role="treeitem"
                aria-expanded={!shut}
                data-object-layer={key}
                className="flex h-6 items-center gap-1 px-1 font-medium"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop({ kind: "layer", layerId: key });
                }}
              >
                <button
                  type="button"
                  className="flex h-4 w-4 items-center justify-center"
                  aria-label={strings.t(shut ? M.expand : M.collapse)}
                  data-layer-twisty={key}
                  onClick={() =>
                    setClosedLayers((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  <Icon
                    name={shut ? "ui-chevron-right" : "ui-chevron-down"}
                    size={11}
                  />
                </button>
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-[2px]"
                  style={{ background: b.colour }}
                  title={strings.t(M.layerColour)}
                  data-layer-colour={b.colour}
                  data-color-preview
                />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {key === NO_LAYER_ID
                    ? strings.t(M.noLayer)
                    : (b.layer.name ?? key)}
                </span>
                <span className="pg-value text-[10px] text-muted-foreground">
                  {b.items.length}
                </span>
              </div>
              {!shut &&
                (b.items.length === 0 ? (
                  <p className="py-0.5 pl-7 text-[11px] text-muted-foreground">
                    {strings.t(M.empty)}
                  </p>
                ) : (
                  b.items.map((n) => renderNode(n, 1, b.colour))
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
