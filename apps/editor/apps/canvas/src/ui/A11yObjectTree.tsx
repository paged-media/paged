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

// The document as a keyboard tree (editor ADR "An accessible object tree";
// decision D-13 of ADR 1201; UXI-A11Y-003, A11Y-004, A11Y-008).
//
// Pixels say nothing to assistive technology, so the canvas has a second,
// structural face: the spreads (pages) of the document, and under each the
// page items front first — frames, groups with their members, a container's
// pasted-in content — as a WAI-ARIA tree. Every item row names the item's
// type, its page, and whether it is locked or hidden; the selection is
// `aria-selected`. Selecting a row selects the item as a canvas click does
// (the engine's selection first, then the shell's mirror with the engine's
// geometry), so the canvas, the inspector and the tree show one accepted
// selection; a canvas selection reveals and marks its row.
//
// VIRTUALIZED, NEVER A GLYPH. Only the rows in view are in the DOM, each
// with `aria-level`, `aria-setsize` and `aria-posinset`, so a document of
// thousands of items costs a screenful of rows; focus stays on the tree and
// `aria-activedescendant` names the active row. Text is not mirrored here:
// a text frame is one row (the caret's text input is the text surface).
// The facts a row needs beyond the scene tree (lock, visibility, page) are
// read for the rows in view only, once per document revision.
//
// KEYS (the APG tree pattern): Up / Down move, Right opens or enters, Left
// closes or climbs, Home / End, Enter or Space select the item (Shift or
// Cmd/Ctrl with Space or Enter toggles it in the selection), Escape gives
// focus back to the canvas (through the Escape arbiter, ADR 1207). The canvas reaches the tree with Alt+Shift+O
// (`paged.view.objectTree`, A11Y_TREE_COMMAND).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  Icon,
  focusCanvasViewport,
  useCanvasClient,
  useDocument,
  useEditorRoot,
  useEscapeHandler,
  useFocusReturn,
  useSelection,
} from "@paged-media/shell";
import type {
  ElementId,
  PropertyEntry,
  SceneTreeNode,
  SelectionMode,
} from "@paged-media/client";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

const M = defineMessages("app.objectTree", {
  label: "Document objects",
  noDocument: "No document loaded.",
  empty: "No objects",
  loading: "Reading objects…",
  page: "Page {name}",
  spread: "Spread {n}, from page {name}",
  onPage: "page {n}",
  locked: "locked",
  hidden: "hidden",
  items: "{count} objects",
  kindTextFrame: "Text frame",
  kindRectangle: "Rectangle",
  kindOval: "Ellipse",
  kindPolygon: "Polygon",
  kindGraphicLine: "Line",
  kindGroup: "Group",
  kindInstance: "Symbol instance",
  kindOther: "Object",
  hint: "Alt+Shift+O moves between the canvas and this tree.",
});

/** One row's height, px. Fixed, so the window is arithmetic. */
export const OBJECT_TREE_ROW_PX = 24;
/** Rows drawn above and below the window. */
const OVERSCAN = 8;
/** Rows drawn where nothing has a height (a DOM without layout). */
const FALLBACK_ROWS = 40;

/** The focus-return surface the tree registers as (ADR 1206). */
export const OBJECT_TREE_SURFACE = "object-tree";

/** One node of the tree: a spread (no id) or a page item. */
export interface ObjectTreeNode {
  key: string;
  id: ElementId | null;
  kind: string;
  /** The engine's label (`<Kind> <self id>`), or the spread's page. */
  label: string;
  /** Front first. */
  children: ObjectTreeNode[];
}

/** A row in view order, with its place in the tree. */
export interface ObjectTreeRow {
  node: ObjectTreeNode;
  /** 1 for a spread. */
  level: number;
  posInSet: number;
  setSize: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** What a row says beyond the scene tree, read per revision. */
export interface RowFacts {
  locked: boolean;
  hidden: boolean;
  /** The name the user gave it (Object options ▸ Name), or null. */
  name: string | null;
  /** 1-based, or null on the pasteboard / unknown. */
  page: number | null;
}

export const itemKey = (id: ElementId): string =>
  `${id.kind}:${String((id as { id?: unknown }).id)}`;

const spreadKey = (i: number): string => `spread:${i}`;

/** The id an item key names (`<kind>:<self id>`). */
export function idOfKey(key: string): ElementId {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at), id: key.slice(at + 1) } as ElementId;
}

/** The scene tree as the object tree shows it: one node per spread, its
 *  page items front first, a group's members (and a container's pasted-in
 *  content) under it, front first. `pageCount` tells single-page spreads
 *  (named after their page) from wider ones. */
export function buildObjectTree(
  roots: ReadonlyArray<SceneTreeNode>,
  pageCount: number,
  strings: Pick<Strings, "t">,
): ObjectTreeNode[] {
  const toNode = (n: SceneTreeNode): ObjectTreeNode | null => {
    if (!n.id) return null;
    return {
      key: itemKey(n.id),
      id: n.id,
      kind: n.kind,
      label: n.label,
      children: (n.children ?? [])
        .map(toNode)
        .filter((c): c is ObjectTreeNode => c !== null)
        .reverse(),
    };
  };
  const onePagePerSpread = roots.length === pageCount;
  return roots.map((spread, i) => {
    const pages =
      spread.kind === "Page"
        ? [spread]
        : (spread.children ?? []).filter((c) => c.kind === "Page");
    const items = pages
      .flatMap((p) => p.children ?? [])
      .map(toNode)
      .filter((c): c is ObjectTreeNode => c !== null)
      .reverse();
    const folio = pages[0]?.label;
    const name = folio && folio !== "Page" ? folio : String(i + 1);
    return {
      key: spreadKey(i),
      id: null,
      kind: "Spread",
      label: onePagePerSpread
        ? strings.t(M.page, { name })
        : strings.t(M.spread, { n: i + 1, name }),
      children: items,
    };
  });
}

/** Spreads start open, groups closed; `expanded` overrides either. */
export function isExpanded(
  node: ObjectTreeNode,
  expanded: ReadonlyMap<string, boolean>,
): boolean {
  return expanded.get(node.key) ?? node.id === null;
}

/** The rows a reader can reach, in order. */
export function visibleRows(
  nodes: ReadonlyArray<ObjectTreeNode>,
  expanded: ReadonlyMap<string, boolean>,
): ObjectTreeRow[] {
  const out: ObjectTreeRow[] = [];
  const walk = (
    list: ReadonlyArray<ObjectTreeNode>,
    level: number,
    parentKey: string | null,
  ) => {
    list.forEach((node, i) => {
      const expandable = node.children.length > 0;
      const open = expandable && isExpanded(node, expanded);
      out.push({
        node,
        level,
        posInSet: i + 1,
        setSize: list.length,
        parentKey,
        expandable,
        expanded: open,
      });
      if (open) walk(node.children, level + 1, node.key);
    });
  };
  walk(nodes, 1, null);
  return out;
}

/** Each node's parent key (spreads: none). */
export function parentsOf(
  nodes: ReadonlyArray<ObjectTreeNode>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (list: ReadonlyArray<ObjectTreeNode>, parent: string | null) => {
    for (const n of list) {
      if (parent) out.set(n.key, parent);
      walk(n.children, n.key);
    }
  };
  walk(nodes, null);
  return out;
}

/** `expanded` with every ancestor of `key` open. */
export function revealed(
  expanded: ReadonlyMap<string, boolean>,
  parents: ReadonlyMap<string, string>,
  key: string,
): ReadonlyMap<string, boolean> {
  let next: Map<string, boolean> | null = null;
  for (let p = parents.get(key); p; p = parents.get(p)) {
    if (expanded.get(p) === true) continue;
    next ??= new Map(expanded);
    next.set(p, true);
  }
  return next ?? expanded;
}

/** The scroll offset that shows row `index` in a `viewportPx` window. */
export function scrollToShow(
  index: number,
  scrollTop: number,
  viewportPx: number,
): number {
  const top = index * OBJECT_TREE_ROW_PX;
  const bottom = top + OBJECT_TREE_ROW_PX;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportPx) return Math.max(0, bottom - viewportPx);
  return scrollTop;
}

/** The type of an item, in the reader's words. */
export function kindWord(kind: string, strings: Pick<Strings, "t">): string {
  switch (kind) {
    case "TextFrame":
      return strings.t(M.kindTextFrame);
    case "Rectangle":
      return strings.t(M.kindRectangle);
    case "Oval":
      return strings.t(M.kindOval);
    case "Polygon":
      return strings.t(M.kindPolygon);
    case "GraphicLine":
      return strings.t(M.kindGraphicLine);
    case "Group":
      return strings.t(M.kindGroup);
    case "Instance":
      return strings.t(M.kindInstance);
    default:
      return strings.t(M.kindOther);
  }
}

/** The item's own name: the engine's label without its leading kind. */
function ownName(node: ObjectTreeNode): string {
  const prefix = `${node.kind} `;
  return node.label.startsWith(prefix)
    ? node.label.slice(prefix.length)
    : node.label;
}

/** What a row's name says after what shows: a spread's object count, an
 *  item's page and the states that hold (selection is `aria-selected`). */
export function rowSuffix(
  row: ObjectTreeRow,
  facts: RowFacts | undefined,
  strings: Pick<Strings, "t">,
): string {
  const n = row.node;
  if (n.id === null)
    return `, ${strings.t(M.items, { count: n.children.length })}`;
  const parts: string[] = [];
  if (facts?.page) parts.push(strings.t(M.onPage, { n: facts.page }));
  if (facts?.locked) parts.push(strings.t(M.locked));
  if (facts?.hidden) parts.push(strings.t(M.hidden));
  return parts.map((p) => `, ${p}`).join("");
}

/** A row's accessible name: type, name, page and the states that hold. */
export function rowName(
  row: ObjectTreeRow,
  facts: RowFacts | undefined,
  strings: Pick<Strings, "t">,
): string {
  const n = row.node;
  const shown =
    n.id === null
      ? n.label
      : `${kindWord(n.kind, strings)} ${facts?.name ?? ownName(n)}`;
  return shown + rowSuffix(row, facts, strings);
}

/** A property read's lock, visibility and the user's name for it. */
export function factsOf(
  entries: ReadonlyArray<PropertyEntry> | null,
): Omit<RowFacts, "page"> {
  let locked = false;
  let hidden = false;
  let name: string | null = null;
  for (const e of entries ?? []) {
    const v = e.value as { type?: string; value?: unknown } | null | undefined;
    if (!v || typeof v !== "object") continue;
    if (e.path === "elementLocked" && v.value === true) locked = true;
    if (e.path === "elementVisible" && v.value === false) hidden = true;
    if (e.path === "itemName" && v.type === "text" && v.value)
      name = String(v.value);
  }
  return { locked, hidden, name };
}

/** The scene tree, re-read after every edit (debounced: a burst of edits
 *  costs one read); `rev` counts the reads, the facts' cache key. */
function useSceneTree(): { roots: SceneTreeNode[]; rev: number } | null {
  const client = useCanvasClient();
  const [state, setState] = useState<{
    roots: SceneTreeNode[];
    rev: number;
  } | null>(null);
  useEffect(() => {
    let live = true;
    let rev = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      void client
        .sceneTree()
        .then((roots) => {
          if (live) setState({ roots, rev: ++rev });
        })
        .catch(() => {
          if (live) setState({ roots: [], rev: ++rev });
        });
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
  }, [client]);
  return state;
}

export function A11yObjectTree() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { elementSelection, setElementSelection, setElementGeometry } =
    useSelection();
  const handle = useDocument().handle;
  const focusReturn = useFocusReturn();
  const root = useEditorRoot();
  const scene = useSceneTree();

  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportPx, setViewportPx] = useState(0);
  const [facts, setFacts] = useState<{
    rev: number;
    map: ReadonlyMap<string, RowFacts>;
  }>({ rev: -1, map: new Map() });
  const listRef = useRef<HTMLDivElement | null>(null);

  const nodes = scene
    ? buildObjectTree(scene.roots, handle?.pageCount ?? 0, strings)
    : [];
  const parents = parentsOf(nodes);
  const rows = visibleRows(nodes, expanded);
  const windowPx =
    viewportPx > 0 ? viewportPx : FALLBACK_ROWS * OBJECT_TREE_ROW_PX;
  const selected = new Set(elementSelection.map(itemKey));

  // A selection made anywhere else (the canvas, a script, Layers) opens the
  // way to its row, makes it the active row and scrolls it into view —
  // adjusted during render, the way React adjusts state to a changed input.
  // A selection the tree does not hold yet (still reading) waits for it.
  const firstSelected =
    elementSelection.length > 0 ? itemKey(elementSelection[0]!) : null;
  const [seenSelection, setSeenSelection] = useState<string | null>(null);
  if (
    firstSelected !== null &&
    seenSelection !== firstSelected &&
    parents.has(firstSelected)
  ) {
    setSeenSelection(firstSelected);
    const open = revealed(expanded, parents, firstSelected);
    if (open !== expanded) setExpanded(open);
    setActiveKey(firstSelected);
    const index = visibleRows(nodes, open).findIndex(
      (r) => r.node.key === firstSelected,
    );
    if (index >= 0) setScrollTop(scrollToShow(index, scrollTop, windowPx));
  }

  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => r.node.key === activeKey),
  );
  const active = rows[activeIndex] ?? null;

  // The window: the rows in view and a margin, never fewer than one.
  const first = Math.max(
    0,
    Math.floor(scrollTop / OBJECT_TREE_ROW_PX) - OVERSCAN,
  );
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + windowPx) / OBJECT_TREE_ROW_PX) + OVERSCAN,
  );
  // The active row stays in the DOM (`aria-activedescendant` names it)
  // even when the wheel scrolled it out of the window.
  const indices: number[] = [];
  if (active && activeIndex < first) indices.push(activeIndex);
  for (let i = first; i < last; i++) indices.push(i);
  if (active && activeIndex >= last) indices.push(activeIndex);
  const shown = indices.map((i) => ({ row: rows[i]!, index: i }));
  const shownKeys = shown
    .filter((s) => s.row.node.id !== null)
    .map((s) => s.row.node.key)
    .join("|");

  // The DOM scroll follows the state (a key press moved the active row).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && Math.abs(el.scrollTop - scrollTop) > 1) el.scrollTop = scrollTop;
  }, [scrollTop]);

  // The window's height, from layout.
  const hasScene = scene !== null;
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportPx(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasScene]);

  // Lock, visibility and page of the rows in view, once per revision. A
  // read in flight is not asked again; its answer lands under the revision
  // it was asked for, so a newer revision never takes an older answer.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!scene || !shownKeys) return;
    const rev = scene.rev;
    const wanted = shownKeys
      .split("|")
      .filter(
        (k) =>
          !(facts.rev === rev && facts.map.has(k)) &&
          !asked.current.has(`${rev}|${k}`),
      );
    if (wanted.length === 0) return;
    for (const k of wanted) asked.current.add(`${rev}|${k}`);
    const ids = wanted.map(idOfKey);
    const pageIds = handle?.pageIds ?? [];
    void Promise.all([
      Promise.all(
        ids.map((id) =>
          client
            .elementProperties(id)
            .then((p) => factsOf(p?.entries ?? null))
            .catch(() => ({ locked: false, hidden: false, name: null })),
        ),
      ),
      client
        .elementGeometry(ids.filter((id) => id.kind !== "group"))
        .catch(() => []),
    ]).then(([flags, geometry]) => {
      const pageOf = new Map<string, number | null>();
      for (const g of geometry) {
        const i = g.pageId == null ? -1 : pageIds.indexOf(g.pageId);
        pageOf.set(itemKey(g.id), i >= 0 ? i + 1 : null);
      }
      setFacts((prev) => {
        if (prev.rev > rev) return prev;
        const map = new Map(prev.rev === rev ? prev.map : []);
        wanted.forEach((k, i) =>
          map.set(k, { ...flags[i]!, page: pageOf.get(k) ?? null }),
        );
        return { rev, map };
      });
    });
  }, [client, scene, shownKeys, facts, handle]);

  const factsFor = (key: string): RowFacts | undefined =>
    scene && facts.rev === scene.rev ? facts.map.get(key) : undefined;

  const select = (id: ElementId, mode: SelectionMode) =>
    client
      .setElementSelection([id], mode)
      .then(async (ids) => {
        setElementSelection(ids);
        setElementGeometry(await client.elementGeometry(ids));
      })
      .catch(() => {});

  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setActiveKey(row.node.key);
    const i = rows.indexOf(row);
    setScrollTop((top) => scrollToShow(i, top, windowPx));
  };

  const setOpen = (key: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Map(prev);
      next.set(key, open);
      return next;
    });

  // Escape in the tree is the tree's (ADR 1207, the `focused` tier): focus
  // goes back to the canvas, which keeps the selection — the press never
  // reaches the tiers below, which would clear it.
  useEscapeHandler({
    id: "paged.objectTree",
    tier: "focused",
    isActive: (e) => {
      const el = listRef.current;
      return Boolean(el && e.target instanceof Node && el.contains(e.target));
    },
    resolve: () => {
      // The focus-return service hands back only focus that dropped; the
      // tree still holds it, so the canvas is focused here.
      focusReturn.close(OBJECT_TREE_SURFACE);
      focusCanvasViewport({ root });
    },
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const row = active;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        moveTo(activeIndex - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row?.expandable) break;
        if (!row.expanded) setOpen(row.node.key, true);
        else moveTo(activeIndex + 1);
        break;
      case "ArrowLeft":
        if (!row) break;
        if (row.expanded) setOpen(row.node.key, false);
        else if (row.parentKey) {
          moveTo(rows.findIndex((r) => r.node.key === row.parentKey));
        }
        break;
      case "Enter":
      case " ":
        if (!row) break;
        if (row.node.id === null) {
          setOpen(row.node.key, !row.expanded);
          break;
        }
        void select(
          row.node.id,
          e.shiftKey || e.metaKey || e.ctrlKey ? "toggle" : "replace",
        );
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (!handle) {
    return (
      <div className="p-3 text-sm text-muted-foreground" data-tree="empty">
        {strings.t(M.noDocument)}
      </div>
    );
  }

  const rowId = (key: string) => `paged-object-tree-${key.replace(/\W/g, "_")}`;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-tree={scene ? "ready" : "loading"}
    >
      <p className="px-2 py-1 pg-ui-xs" data-object-tree-hint>
        {strings.t(M.hint)}
      </p>
      <div
        ref={listRef}
        role="tree"
        aria-label={strings.t(M.label)}
        aria-multiselectable="true"
        aria-activedescendant={active ? rowId(active.node.key) : undefined}
        tabIndex={0}
        data-object-tree
        className="min-h-0 flex-1 overflow-auto"
        style={{ maxHeight: "100%" }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!activeKey && rows[0]) setActiveKey(rows[0].node.key);
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {!scene && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {strings.t(M.loading)}
          </p>
        )}
        {scene && rows.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {strings.t(M.empty)}
          </p>
        )}
        <div
          role="none"
          style={{
            height: rows.length * OBJECT_TREE_ROW_PX,
            position: "relative",
          }}
        >
          {shown.map(({ row, index }) => {
            const n = row.node;
            const f = n.id ? factsFor(n.key) : undefined;
            const isSelected = n.id !== null && selected.has(n.key);
            const isActive = active?.node.key === n.key;
            return (
              <div
                key={n.key}
                id={rowId(n.key)}
                role="treeitem"
                aria-level={row.level}
                aria-posinset={row.posInSet}
                aria-setsize={row.setSize}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-selected={n.id === null ? undefined : isSelected}
                data-tree-row={n.id ? n.key : n.kind}
                data-object-key={n.key}
                data-selected={isSelected ? "" : undefined}
                data-active={isActive ? "" : undefined}
                data-locked={f?.locked ? "" : undefined}
                data-hidden={f?.hidden ? "" : undefined}
                className="absolute left-0 right-0 flex cursor-default items-center gap-1 pr-2 text-xs hover:bg-muted/60 data-[active]:outline data-[active]:outline-1 data-[active]:outline-ring data-[selected]:bg-muted"
                style={{
                  top: index * OBJECT_TREE_ROW_PX,
                  height: OBJECT_TREE_ROW_PX,
                  paddingLeft: 4 + (row.level - 1) * 14,
                }}
                onClick={(e) => {
                  setActiveKey(n.key);
                  if (n.id === null) return;
                  void select(
                    n.id,
                    e.shiftKey || e.metaKey || e.ctrlKey ? "toggle" : "replace",
                  );
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center justify-center"
                  onClick={(e) => {
                    if (!row.expandable) return;
                    e.stopPropagation();
                    setActiveKey(n.key);
                    setOpen(n.key, !row.expanded);
                  }}
                >
                  {row.expandable && (
                    <Icon
                      name={
                        row.expanded ? "ui-chevron-down" : "ui-chevron-right"
                      }
                      size={11}
                    />
                  )}
                </span>
                {/* The row's name is its text (WCAG 2.5.3, label in
                    name): what shows, and the facts the badges show,
                    in words only a reader hears (`rowName`). */}
                {n.id === null ? (
                  <>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {n.label}
                    </span>
                    <span className="sr-only">
                      {rowSuffix(row, f, strings)}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="shrink-0">
                      {kindWord(n.kind, strings)}
                    </span>{" "}
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {f?.name ?? ownName(n)}
                    </span>
                    <span className="sr-only">
                      {rowSuffix(row, f, strings)}
                    </span>
                    {f?.locked && (
                      <span aria-hidden="true" title={strings.t(M.locked)}>
                        <Icon name="ui-lock" size={11} />
                      </span>
                    )}
                    {f?.hidden && (
                      <span aria-hidden="true" title={strings.t(M.hidden)}>
                        <Icon name="ui-eye-off" size={11} />
                      </span>
                    )}
                    {f?.page ? (
                      <span
                        aria-hidden="true"
                        className="pg-value shrink-0 text-[10px] text-muted-foreground"
                      >
                        {f.page}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
