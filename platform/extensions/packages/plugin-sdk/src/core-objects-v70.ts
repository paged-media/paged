/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The CORE half of `host.objects` (ADR 323 rule 5) for an engine BELOW
// protocol 71 (the published editor's, until v0.71.0 ships): the interim
// seam over the protocol-69/70 wire. core-objects.ts picks it when the
// engine reports protocol < 71; at 71 core-objects-v71.ts sends address
// strings straight to `Set` / `RequestGet` / `RequestQuery`. Every core address kind maps, through ONE table per kind,
// to the reads and ops the published engine already has:
//
//   kind     read                                write
//   frame    requestElementProperties            setElementProperty
//   story    requestElementProperties (range),   setElementProperty (range);
//            stories + storyContent              content → deleteRange+insertText
//   layer    layers collection                   layerSet{Visible,Locked,Printable,Name}
//   page     pages collection                    pageBounds → resizePage,
//                                                appliedMaster → applyMasterToPage
//   doc      documentMeta                        default* → setDocumentDefaults
//   swatch   swatches + requestColorPreview      space/value → editSwatch
//   style    requestStyleProperties              setStyleProperty
//   spread / master   collections                read-only
//   table / cell     requestElementProperties    setElementProperty — only once
//                    (TableCell / Table ids)     the table's story is known
//                                                (`noteTableStory`; the cell
//                                                address carries no story)
//   field / gradient / …                         "unmapped" — no address form on
//                                                the v69 wire (ADR 131/132)
//
// When core's `Mutation::Set { address, path, value }` and `Get` land
// (ADR 132), `planSet` collapses to one `{ op: "set", … }` and `get` to one
// `Get` — the table below is exactly the part that disappears. The seam
// is `CoreObjects`; the registry never sees a wire shape.

import type {
  CollectionName,
  ElementId,
  LayerSummary,
  MutationInput,
  ObjectErrorCode,
  ObjectValue,
  PageSummary,
  PagedEditor,
  ParsedAddress,
  PropertySchema,
  SceneTreeNode,
  StyleFamily,
  ValueType,
} from "@paged-media/plugin-api";

import type { CoreObjects, CorePlan } from "./core-objects";
import { planCoreDelete } from "./core-ops";
import { CORE_PATHS, corePathRange, type CorePathRow, type CorePathScope } from "./core-schema";
import { formatAddress, fromElementId, type SelectorStep } from "./object-address";

/** One core object as the selector engine sees it. */
interface CoreNode {
  address: string;
  /** Selector kind words this node answers to. */
  kinds: readonly string[];
  parent: string | null;
  attrs: Record<string, string>;
}

const refuse = (code: ObjectErrorCode, reason: string): ObjectValue => ({ kind: "refused", code, reason });
const val = (value: unknown): ObjectValue => ({ kind: "value", value });

// ------------------------------------------------------------- schemas

const ro = (path: string, type: ValueType, summary?: string, access: "readOnly" | "derived" = "readOnly"): PropertySchema => ({
  path,
  type,
  access,
  ...(summary ? { summary } : {}),
});

function rowsOf(scope: CorePathScope, addressKind: string): PropertySchema[] {
  const rows: PropertySchema[] = [];
  for (const [path, row] of Object.entries(CORE_PATHS)) {
    if ("op" in row || "since" in row || row.scope !== scope || !row.type) continue;
    const r: PropertySchema = { addressKind, path, type: row.type, nullable: true };
    const range = corePathRange(path);
    if (range) r.range = range;
    if (row.readOnly) r.access = "readOnly";
    rows.push(r);
  }
  return rows;
}

const SWATCH_SPACES = ["CMYK", "RGB", "LAB", "Gray"];

/** The read-only label map every label host answers (writes go through a
 *  plugin's `state` write, which names its caller). */
const LABELS_ROW: PropertySchema = ro(
  "labels",
  { kind: "map", of: { kind: "text" }, keyPattern: "^x-paged:" },
  "The element's x-paged: plugin labels: key → the label's JSON envelope.",
);

/** Extra (virtual) rows per kind, beyond the PropertyPath table. */
const VIRTUAL: Record<string, PropertySchema[]> = {
  frame: [LABELS_ROW],
  doc: [
    LABELS_ROW,
    ro("pageCount", { kind: "number", integer: true }, "Number of pages.", "derived"),
    ro("documentName", { kind: "text" }),
    ro("dirty", { kind: "bool" }, "Unsaved edits.", "derived"),
    { path: "defaultFillColor", type: { kind: "color" }, nullable: true, virtual: { op: "setDocumentDefaults", field: "fillColor" } },
    { path: "defaultStrokeColor", type: { kind: "color" }, nullable: true, virtual: { op: "setDocumentDefaults", field: "strokeColor" } },
    { path: "defaultStrokeWeight", type: { kind: "length" }, nullable: true, virtual: { op: "setDocumentDefaults", field: "strokeWeight" } },
  ],
  page: [
    LABELS_ROW,
    ro("index", { kind: "number", integer: true }, "1-based page number.", "derived"),
    ro("marginTop", { kind: "length" }),
    ro("marginLeft", { kind: "length" }),
    ro("marginBottom", { kind: "length" }),
    ro("marginRight", { kind: "length" }),
    ro("columnCount", { kind: "number", integer: true }),
    ro("columnGutter", { kind: "length" }),
    { path: "appliedMaster", type: { kind: "ref", to: "master" }, nullable: true, virtual: { op: "applyMasterToPage" } },
  ],
  story: [
    ro("characterCount", { kind: "number", integer: true }, undefined, "derived"),
    ro("paragraphCount", { kind: "number", integer: true }, undefined, "derived"),
    ro("overset", { kind: "bool" }, undefined, "derived"),
    { path: "content", type: { kind: "text", multiline: true }, heavy: true, summary: "The story's plain text; \\n splits paragraphs." },
  ],
  swatch: [
    ro("name", { kind: "text" }),
    ro("swatchKind", { kind: "text" }),
    { path: "space", type: { kind: "enum", members: SWATCH_SPACES }, virtual: { op: "editSwatch", field: "space" } },
    { path: "value", type: { kind: "list", of: { kind: "number" } }, virtual: { op: "editSwatch", field: "value" } },
  ],
  style: [ro("name", { kind: "text" }), ro("basedOn", { kind: "ref", to: "style" })],
  spread: [ro("label", { kind: "text" }), ro("pageCount", { kind: "number", integer: true }, undefined, "derived")],
  master: [ro("label", { kind: "text" }), ro("pageCount", { kind: "number", integer: true }, undefined, "derived")],
};

/** The layer rows are PropertyPaths, but written through dedicated ops. */
const LAYER_OPS: Record<string, { op: "layerSetVisible" | "layerSetLocked" | "layerSetPrintable" | "layerSetName"; field: keyof LayerSummary; arg: string }> = {
  layerVisible: { op: "layerSetVisible", field: "visible", arg: "visible" },
  layerLocked: { op: "layerSetLocked", field: "locked", arg: "locked" },
  layerPrintable: { op: "layerSetPrintable", field: "printable", arg: "printable" },
  layerName: { op: "layerSetName", field: "name", arg: "name" },
};

const CORE_KINDS: Array<{ kind: string; title: string; addressForm: string; scope?: CorePathScope }> = [
  { kind: "doc", title: "Document", addressForm: "doc" },
  { kind: "frame", title: "Page item", addressForm: "<textFrame|rectangle|oval|polygon|graphicLine|group>:<id>", scope: "frame" },
  { kind: "story", title: "Story", addressForm: "story:<id> · storyRange:<id>@<start>..<end>", scope: "story" },
  { kind: "page", title: "Page", addressForm: "page:<id> · page:#<n>", scope: "page" },
  { kind: "spread", title: "Spread", addressForm: "spread:<id>" },
  { kind: "master", title: "Master spread", addressForm: "master:<id>" },
  { kind: "layer", title: "Layer", addressForm: "layer:<id>", scope: "layer" },
  { kind: "table", title: "Table", addressForm: "table:<id>", scope: "table" },
  { kind: "cell", title: "Table cell", addressForm: "cell:<table>/<row>,<col>", scope: "cell" },
  { kind: "style", title: "Style", addressForm: "style:<family>/<self id or name>", scope: "story" },
  { kind: "swatch", title: "Swatch", addressForm: "swatch:<self id or name>" },
];

/** Wire `Value` for a schema-valid value on a PropertyPath row. A raw
 *  `{ type, value }` passes through untouched (structured paths). */
function toWire(row: CorePathRow, value: unknown): unknown {
  if (isRawWire(value)) return value;
  return { type: row.wire, value };
}

function isRawWire(value: unknown): value is { type: string; value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    "value" in value
  );
}

const STYLE_COLLECTION: Record<StyleFamily, CollectionName> = {
  paragraph: "paragraphStyles",
  character: "characterStyles",
  object: "objectStyles",
  cell: "cellStyles",
  table: "tableStyles",
};

// ------------------------------------------------------------ backend

/** The pre-71 core seam. `tableStories` maps a table id to its story (the
 *  `cell:` / `table:` address carries no story; the wire's `TableCell`
 *  needs it) — fed by `noteTableStory`. */
export function createCoreObjectsV70(getEditor: () => PagedEditor): CoreObjects & { kindOf(a: ParsedAddress): string } {
  const client = () => getEditor().client;

  // The derived caches (tree index, node list) are rebuilt after ANY engine
  // change. One tree read per edit, not per call (host-call budget).
  let generation = 0;
  let nodesCache: { gen: number; nodes: CoreNode[]; items: Map<string, ElementId> } | null = null;
  const listeners = new Set<() => void>();
  let subscribed = false;
  /** False when the host offers no change subscription: no caching. */
  let live = true;
  let unsubscribe: (() => void) | null = null;
  const ensureSubscribed = (): void => {
    if (subscribed) return;
    subscribed = true;
    try {
      unsubscribe = client().subscribe((msg) => {
        if (
          msg.kind === "mutationApplied" ||
          msg.kind === "undoApplied" ||
          msg.kind === "redoApplied" ||
          msg.kind === "documentLoaded"
        ) {
          generation++;
          for (const l of listeners) l();
        }
      });
    } catch {
      live = false; // a host without subscriptions: rebuild per call
    }
  };

  async function collection<T>(name: CollectionName): Promise<readonly T[]> {
    try {
      return await client().collection<T>(name);
    } catch {
      return [];
    }
  }

  async function send(kind: string, payload: unknown): Promise<{ kind: string; payload: any } | null> {
    try {
      return (await client().send({ kind, payload } as never)) as never;
    } catch {
      return null;
    }
  }

  async function nodes(): Promise<{ nodes: CoreNode[]; items: Map<string, ElementId> }> {
    ensureSubscribed();
    if (live && nodesCache && nodesCache.gen === generation) return nodesCache;
    const out: CoreNode[] = [{ address: "doc", kinds: ["doc"], parent: null, attrs: {} }];
    const items = new Map<string, ElementId>();
    const [spreads, pages, layers, stories, swatches, masters] = await Promise.all([
      collection<{ selfId: string; label: string }>("spreads"),
      collection<PageSummary>("pages"),
      collection<LayerSummary>("layers"),
      collection<{ selfId: string }>("stories"),
      collection<{ selfId: string; name: string; kind: string }>("swatches"),
      collection<{ selfId: string; label: string }>("masterPages"),
    ]);
    const reply = await send("requestSceneTree", undefined);
    const roots: SceneTreeNode[] = reply?.kind === "sceneTree" ? reply.payload.roots : [];
    let spreadIx = 0;
    let pageIx = 0;
    const walk = (list: readonly SceneTreeNode[], parent: string): void => {
      for (const n of list) {
        if (n.id && typeof n.id.id === "string") {
          const address = fromElementId(n.id);
          items.set(n.id.id, n.id);
          const attrs: Record<string, string> = { kind: n.id.kind };
          for (const e of n.pluginMetadata ?? []) attrs[`label.${e.key}`] = e.value;
          out.push({ address, kinds: ["frame", n.id.kind], parent, attrs });
          walk(n.children ?? [], address);
        } else if (n.kind === "Spread") {
          const s = spreads[spreadIx++];
          const address = s ? formatAddress({ kind: "spread", id: s.selfId }) : parent;
          if (s) out.push({ address, kinds: ["spread"], parent: "doc", attrs: { name: s.label, label: s.label } });
          walk(n.children ?? [], address);
        } else if (n.kind === "Page") {
          const p = pages[pageIx++];
          const address = p ? formatAddress({ kind: "page", id: p.selfId }) : parent;
          if (p) out.push({ address, kinds: ["page"], parent, attrs: pageAttrs(p) });
          walk(n.children ?? [], address);
        } else {
          walk(n.children ?? [], parent);
        }
      }
    };
    walk(roots, "doc");
    // Pages the tree did not reach (no spread rows) still answer `page`.
    for (const p of pages.slice(pageIx)) {
      out.push({ address: formatAddress({ kind: "page", id: p.selfId }), kinds: ["page"], parent: "doc", attrs: pageAttrs(p) });
    }
    for (const l of layers) {
      out.push({ address: formatAddress({ kind: "layer", id: l.selfId }), kinds: ["layer"], parent: "doc", attrs: { name: l.name ?? "" } });
    }
    for (const s of stories) {
      out.push({ address: formatAddress({ kind: "story", id: s.selfId }), kinds: ["story"], parent: "doc", attrs: {} });
    }
    for (const s of swatches) {
      out.push({ address: formatAddress({ kind: "swatch", name: s.selfId }), kinds: ["swatch"], parent: "doc", attrs: { name: s.name, kind: s.kind } });
    }
    for (const m of masters) {
      out.push({ address: formatAddress({ kind: "master", id: m.selfId }), kinds: ["master"], parent: "doc", attrs: { name: m.label, label: m.label } });
    }
    for (const family of Object.keys(STYLE_COLLECTION) as StyleFamily[]) {
      for (const s of await collection<{ selfId: string; name: string }>(STYLE_COLLECTION[family])) {
        out.push({
          address: formatAddress({ kind: "style", family, name: s.selfId }),
          kinds: ["style", `style:${family}`],
          parent: "doc",
          attrs: { name: s.name, family },
        });
      }
    }
    nodesCache = { gen: generation, nodes: out, items };
    return nodesCache;
  }

  /** A page node's selector attributes, with its v70 labels. */
  function pageAttrs(p: PageSummary): Record<string, string> {
    const attrs: Record<string, string> = { name: String(p.index), index: String(p.index) };
    for (const e of (p as { pluginMetadata?: { key: string; value: string }[] }).pluginMetadata ?? []) attrs[`label.${e.key}`] = e.value;
    return attrs;
  }

  async function labelsOf(a: ParsedAddress): Promise<Record<string, string> | null> {
    const fromEntries = (list: readonly { key: string; value: string }[] | undefined) =>
      Object.fromEntries((list ?? []).map((e) => [e.key, e.value]));
    if (a.kind === "doc") {
      try {
        return fromEntries(((await client().documentMeta()) as { pluginMetadata?: { key: string; value: string }[] }).pluginMetadata);
      } catch {
        return null;
      }
    }
    if (a.kind === "page" || a.kind === "pageIndex") {
      const p = await resolvePage(a);
      return p ? fromEntries((p as { pluginMetadata?: { key: string; value: string }[] }).pluginMetadata) : null;
    }
    const id = await propertyTarget(a);
    if (!id) return null;
    const r = await send("requestElementProperties", { id });
    if (r?.kind !== "elementProperties" || !r.payload.result) return null;
    const out: Record<string, string> = {};
    for (const e of r.payload.result.entries as { value?: { type: string; value: { key: string; value?: string | null } } | null }[]) {
      const v = e.value;
      if (v && v.type === "pluginMetadata" && typeof v.value.value === "string") out[v.value.key] = v.value.value;
    }
    return out;
  }

  /** The item ElementId behind `frame:` / `<kind>:` (null = no such item). */
  async function itemId(a: ParsedAddress): Promise<ElementId | null> {
    if (a.kind !== "item" && a.kind !== "frame") return null;
    const found = (await nodes()).items.get(a.id);
    if (!found) return null;
    if (a.kind === "item" && found.kind !== a.itemKind) return null;
    return found;
  }

  async function storyLength(id: string): Promise<number | null> {
    const s = (await collection<{ selfId: string; characterCount: number }>("stories")).find((x) => x.selfId === id);
    return s ? s.characterCount : null;
  }

  /** The ElementId a frame/story PropertyPath reads/writes through. */
  async function propertyTarget(a: ParsedAddress): Promise<ElementId | null> {
    if (a.kind === "item" || a.kind === "frame") return itemId(a);
    if (a.kind === "storyRange") return { kind: "storyRange", id: { story_id: a.story, start: a.start, end: a.end } };
    if (a.kind === "story") {
      const len = await storyLength(a.id);
      return len === null ? null : { kind: "storyRange", id: { story_id: a.id, start: 0, end: Math.max(len, 0) } };
    }
    return null;
  }

  async function readEntries(id: ElementId): Promise<Map<string, unknown> | null> {
    const r = await send("requestElementProperties", { id });
    if (r?.kind !== "elementProperties" || !r.payload.result) return null;
    return new Map((r.payload.result.entries as { path: string; value?: { value: unknown } | null }[]).map((e) => [e.path, e.value]));
  }

  async function resolveStyle(a: Extract<ParsedAddress, { kind: "style" }>): Promise<string | null> {
    const list = await collection<{ selfId: string; name: string }>(STYLE_COLLECTION[a.family]);
    return (list.find((s) => s.selfId === a.name) ?? list.find((s) => s.name === a.name))?.selfId ?? null;
  }

  async function resolveSwatch(name: string): Promise<{ selfId: string; name: string; kind: string } | null> {
    const list = await collection<{ selfId: string; name: string; kind: string }>("swatches");
    return list.find((s) => s.selfId === name) ?? list.find((s) => s.name === name) ?? null;
  }

  async function resolvePage(a: ParsedAddress): Promise<PageSummary | null> {
    const pages = await collection<PageSummary>("pages");
    if (a.kind === "pageIndex") return pages[a.index - 1] ?? null;
    if (a.kind === "page") return pages.find((p) => p.selfId === a.id) ?? null;
    return null;
  }

  const pathRow = (path: string, scope: CorePathScope): CorePathRow | null => {
    const row = (CORE_PATHS as Record<string, CorePathRow | { op: true } | { since: 71 }>)[path];
    return row && !("op" in row) && !("since" in row) && row.scope === scope ? row : null;
  };

  const kindOf = (a: ParsedAddress): string =>
    a.kind === "item" || a.kind === "frame" || a.kind === "onMaster"
      ? "frame"
      : a.kind === "pageIndex"
        ? "page"
        : a.kind === "storyRange"
          ? "story"
          : a.kind;

  // The table seam (moved here from the editor's object-model.ts): a
  // `cell:` / `table:` address has no story, the wire's ids need one.
  const tableStories = new Map<string, string>();
  const tableTarget = (a: ParsedAddress): ElementId | null => {
    if (a.kind === "cell") {
      const story = tableStories.get(a.table);
      return story ? { kind: "tableCell", id: { story_id: story, table_id: a.table, row: a.row, col: a.col } } : null;
    }
    if (a.kind === "table") {
      const story = tableStories.get(a.id);
      return story ? { kind: "table", id: { story_id: story, table_id: a.id } } : null;
    }
    return null;
  };

  const unmapped = (a: ParsedAddress): ObjectValue =>
    refuse("unmapped", `${formatAddress(a)}: the protocol-70 wire has no form for this address; it needs engine protocol 71 (core's Get/Set, ADR 132)`);

  return {
    kindOf,

    async ready() {
      return 70;
    },

    noteTableStory(tableId, storyId) {
      tableStories.set(tableId, storyId);
    },

    kinds() {
      return CORE_KINDS.map(({ kind, title, addressForm }) => ({ owner: "core", kind, title, addressForm }));
    },

    schema(kind) {
      const base = kind.startsWith("style:") ? "style" : kind;
      const spec = CORE_KINDS.find((k) => k.kind === base);
      if (!spec) return [];
      const rows = spec.scope ? rowsOf(spec.scope, base) : [];
      return [...rows, ...(VIRTUAL[base] ?? []).map((r) => ({ addressKind: base, ...r }))];
    },

    async get(a, path) {
      const kind = kindOf(a);
      switch (kind) {
        case "frame":
        case "story": {
          if (a.kind === "onMaster") return unmapped(a);
          if (kind === "story") {
            const story = a.kind === "story" ? a.id : a.kind === "storyRange" ? a.story : "";
            const s = (await collection<{ selfId: string; characterCount: number; paragraphCount: number; overset?: boolean }>("stories")).find((x) => x.selfId === story);
            if (!s) return refuse("unknownAddress", `no story ${story}`);
            if (path === "characterCount") return val(s.characterCount);
            if (path === "paragraphCount") return val(s.paragraphCount);
            if (path === "overset") return val(s.overset ?? false);
            if (path === "content") {
              const r = await send("requestStoryContent", { storyId: story });
              const content = r?.kind === "storyContentResult" ? r.payload.content : null;
              if (!content) return refuse("failed", `story ${story}: no content`);
              const text = (content.paragraphs as { runs: { text: string }[] }[])
                .map((p) => p.runs.map((x) => x.text).join(""))
                .join("\n");
              return val(a.kind === "storyRange" ? text.slice(a.start, a.end) : text);
            }
          }
          if (kind === "frame" && path === "labels") {
            const labels = await labelsOf(a);
            return labels ? val(labels) : refuse("unknownAddress", `no frame ${formatAddress(a)}`);
          }
          if (!pathRow(path, kind)) return refuse("unknownPath", `${kind} has no path "${path}"`);
          const id = await propertyTarget(a);
          if (!id) return refuse("unknownAddress", `no ${kind} ${formatAddress(a)}`);
          const entries = await readEntries(id);
          if (!entries) return refuse("unknownAddress", `no ${kind} ${formatAddress(a)}`);
          if (!entries.has(path)) return { kind: "absent" };
          const v = entries.get(path) as { value: unknown } | null | undefined;
          return v == null ? { kind: "mixed" } : val(v.value);
        }
        case "layer": {
          if (a.kind !== "layer") return unmapped(a);
          const l = (await collection<LayerSummary>("layers")).find((x) => x.selfId === a.id);
          if (!l) return refuse("unknownAddress", `no layer ${a.id}`);
          const op = LAYER_OPS[path];
          return op ? val(l[op.field] ?? null) : refuse("unknownPath", `layer has no path "${path}"`);
        }
        case "page": {
          const p = await resolvePage(a);
          if (!p) return refuse("unknownAddress", `no page ${formatAddress(a)}`);
          const map: Record<string, unknown> = {
            labels: Object.fromEntries(((p as { pluginMetadata?: { key: string; value: string }[] }).pluginMetadata ?? []).map((e) => [e.key, e.value])),
            pageBounds: [0, 0, p.sizePt[1], p.sizePt[0]],
            index: p.index,
            marginTop: p.marginTopPt ?? null,
            marginLeft: p.marginLeftPt ?? null,
            marginBottom: p.marginBottomPt ?? null,
            marginRight: p.marginRightPt ?? null,
            columnCount: p.columnCount ?? null,
            columnGutter: p.columnGutterPt ?? null,
          };
          if (path === "appliedMaster") return { kind: "absent" };
          return path in map ? val(map[path]) : refuse("unknownPath", `page has no path "${path}"`);
        }
        case "doc": {
          let meta: Record<string, unknown>;
          try {
            meta = (await client().documentMeta()) as unknown as Record<string, unknown>;
          } catch {
            return refuse("unknownAddress", "no document loaded");
          }
          if (path === "labels") {
            const list = (meta["pluginMetadata"] ?? []) as { key: string; value: string }[];
            return val(Object.fromEntries(list.map((e) => [e.key, e.value])));
          }
          return VIRTUAL["doc"]!.some((r) => r.path === path)
            ? val(meta[path] ?? null)
            : refuse("unknownPath", `doc has no path "${path}"`);
        }
        case "swatch": {
          if (a.kind !== "swatch") return unmapped(a);
          const s = await resolveSwatch(a.name);
          if (!s) return refuse("unknownAddress", `no swatch ${a.name}`);
          if (path === "name") return val(s.name);
          if (path === "swatchKind") return val(s.kind);
          if (path === "space" || path === "value") {
            const r = await send("requestColorPreview", { swatchId: s.selfId });
            const c = r?.kind === "colorPreviewReply" ? r.payload.result : null;
            return c ? val(c[path] ?? null) : { kind: "absent" };
          }
          return refuse("unknownPath", `swatch has no path "${path}"`);
        }
        case "style": {
          if (a.kind !== "style") return unmapped(a);
          const styleId = await resolveStyle(a);
          if (!styleId) return refuse("unknownAddress", `no ${a.family} style ${a.name}`);
          const r = await send("requestStyleProperties", { collection: a.family, styleId });
          const res = r?.kind === "styleProperties" ? r.payload.result : null;
          if (!res) return refuse("failed", `style ${styleId}: no properties`);
          if (path === "name") return val(res.name ?? null);
          if (path === "basedOn") return val(res.basedOn ?? null);
          const e = (res.entries as { path: string; value?: { value: unknown } | null }[]).find((x) => x.path === path);
          if (!e) return pathRow(path, "story") ? { kind: "absent" } : refuse("unknownPath", `style has no path "${path}"`);
          return e.value == null ? { kind: "absent" } : val(e.value.value);
        }
        case "cell":
        case "table": {
          if (!pathRow(path, kind)) return refuse("unknownPath", `${kind} has no path "${path}"`);
          const id = tableTarget(a);
          if (!id) return unmapped(a);
          const entries = await readEntries(id);
          if (!entries) return refuse("unknownAddress", `no ${kind} ${formatAddress(a)}`);
          if (!entries.has(path)) return { kind: "absent" };
          const v = entries.get(path) as { value: unknown } | null | undefined;
          return v == null ? { kind: "mixed" } : val(v.value);
        }
        case "spread":
        case "master": {
          const id = (a as { id: string }).id;
          const list = await collection<{ selfId: string; label: string; pageCount: number }>(kind === "spread" ? "spreads" : "masterPages");
          const s = list.find((x) => x.selfId === id);
          if (!s) return refuse("unknownAddress", `no ${kind} ${id}`);
          return path === "label" || path === "pageCount" ? val(s[path]) : refuse("unknownPath", `${kind} has no path "${path}"`);
        }
        default:
          return unmapped(a);
      }
    },

    async planSet(a, path, value) {
      const no = (code: ObjectErrorCode, reason: string): CorePlan => ({ ok: false, code, reason });
      const ok = (...mutations: MutationInput[]): CorePlan => ({ ok: true, mutations });
      const kind = kindOf(a);
      switch (kind) {
        case "frame":
        case "story": {
          if (a.kind === "onMaster") return no("unmapped", "items on masters land with core's Set (ADR 131)");
          if (kind === "story" && path === "content") {
            const story = a.kind === "story" ? a.id : a.kind === "storyRange" ? a.story : "";
            const len = await storyLength(story);
            if (len === null) return no("unknownAddress", `no story ${story}`);
            const [start, end] = a.kind === "storyRange" ? [a.start, a.end] : [0, len];
            const ops: MutationInput[] = [];
            if (end > start) ops.push({ op: "deleteRange", args: { storyId: story, start, end } });
            if (typeof value === "string" && value.length > 0) {
              ops.push({ op: "insertText", args: { storyId: story, offset: start, text: value } });
            }
            return ok(...ops);
          }
          const row = pathRow(path, kind);
          if (!row) return no("unknownPath", `${kind} has no path "${path}"`);
          const id = await propertyTarget(a);
          if (!id) return no("unknownAddress", `no ${kind} ${formatAddress(a)}`);
          return ok({ op: "setElementProperty", args: { elementId: id, path: path as never, value: toWire(row, value) as never } });
        }
        case "layer": {
          if (a.kind !== "layer") return no("unmapped", "");
          const op = LAYER_OPS[path];
          if (!op) return no("unknownPath", `layer has no path "${path}"`);
          if (!(await collection<LayerSummary>("layers")).some((l) => l.selfId === a.id)) {
            return no("unknownAddress", `no layer ${a.id}`);
          }
          return ok({ op: op.op, args: { layerId: a.id, [op.arg]: value } } as MutationInput);
        }
        case "page": {
          const p = await resolvePage(a);
          if (!p) return no("unknownAddress", `no page ${formatAddress(a)}`);
          if (path === "pageBounds") return ok({ op: "resizePage", args: { pageId: p.selfId, bounds: value as [number, number, number, number] } });
          if (path === "appliedMaster") {
            return ok({ op: "applyMasterToPage", args: { page: p.selfId, master: (value as string | null) ?? null } });
          }
          return no("unknownPath", `page has no writable path "${path}"`);
        }
        case "doc": {
          const field = { defaultFillColor: "fillColor", defaultStrokeColor: "strokeColor", defaultStrokeWeight: "strokeWeight" }[path];
          if (!field) return no("unknownPath", `doc has no writable path "${path}"`);
          // WHOLE-STATE op: read the triple, change one field, write back.
          const meta = await client().documentMeta();
          const args = {
            fillColor: meta.defaultFillColor ?? null,
            strokeColor: meta.defaultStrokeColor ?? null,
            strokeWeight: meta.defaultStrokeWeight ?? null,
            [field]: value,
          };
          return ok({ op: "setDocumentDefaults", args } as MutationInput);
        }
        case "swatch": {
          if (a.kind !== "swatch") return no("unmapped", `${formatAddress(a)} lands with core's Set`);
          const s = await resolveSwatch(a.name);
          if (!s) return no("unknownAddress", `no swatch ${a.name}`);
          if (path !== "space" && path !== "value") return no("unknownPath", `swatch has no writable path "${path}"`);
          const r = await send("requestColorPreview", { swatchId: s.selfId });
          const c = r?.kind === "colorPreviewReply" ? r.payload.result : null;
          if (!c) return no("failed", `swatch ${s.selfId}: no colour to edit`);
          const spec = {
            selfId: s.selfId,
            name: s.name,
            space: path === "space" ? (value as string) : (c.space ?? "CMYK"),
            value: path === "value" ? (value as number[]) : (c.value ?? c.cmyk ?? []),
            model: c.model ?? null,
          };
          return ok({ op: "editSwatch", args: { swatchId: s.selfId, spec } } as MutationInput);
        }
        case "style": {
          if (a.kind !== "style") return no("unmapped", "");
          const row = pathRow(path, "story");
          if (!row) return no("unknownPath", `style has no writable path "${path}"`);
          const styleId = await resolveStyle(a);
          if (!styleId) return no("unknownAddress", `no ${a.family} style ${a.name}`);
          return ok({ op: "setStyleProperty", args: { collection: a.family, styleId, path: path as never, value: toWire(row, value) as never } });
        }
        case "cell":
        case "table": {
          const row = pathRow(path, kind);
          if (!row) return no("unknownPath", `${kind} has no path "${path}"`);
          if (row.readOnly) return no("readOnly", `${path} is read-only`);
          const id = tableTarget(a);
          if (!id) return no("unmapped", `${formatAddress(a)}: the table's story is unknown (noteTableStory) — engine protocol 71 addresses cells directly`);
          return ok({ op: "setElementProperty", args: { elementId: id, path: path as never, value: toWire(row, value) as never } });
        }
        default:
          return no("unmapped", `${formatAddress(a)}: no write on the protocol-70 wire; needs engine protocol 71 (core's Set, ADR 132)`);
      }
    },

    labelsOf,

    async planLabel(a, key, value, caller) {
      if (a.kind === "doc") return { op: "setDocumentMetadata", args: { key, value, caller } };
      if (a.kind === "page" || a.kind === "pageIndex") {
        const p = await resolvePage(a);
        return p ? { op: "setPageMetadata", args: { page: p.selfId, key, value, caller } } : null;
      }
      const id = a.kind === "item" || a.kind === "frame" || a.kind === "story" || a.kind === "storyRange" ? await propertyTarget(a) : null;
      return id ? { op: "setPluginMetadata", args: { elementId: id, key, value, caller } } : null;
    },

    async planCreate(op) {
      return { ok: false, code: "unmapped", reason: `create "${op.kind}": core creates need engine protocol 71 (this engine is older)` };
    },

    async planDelete(a) {
      return planCoreDelete(a, async (name) => (await resolveSwatch(name))?.selfId ?? null, async (p) => (await resolvePage(p))?.selfId ?? null, 70);
    },

    async elementIdOf(a) {
      return a.kind === "item" || a.kind === "frame" ? itemId(a) : a.kind === "storyRange" ? propertyTarget(a) : null;
    },

    async query(steps) {
      const { nodes: all, items } = await nodes();
      const wantOf = (a: ParsedAddress): string => {
        if (a.kind !== "frame") return formatAddress(a);
        const id = items.get(a.id);
        return id ? fromElementId(id) : "";
      };
      const byAddress = new Map(all.map((n) => [n.address, n]));
      const matches = (n: CoreNode, step: SelectorStep): boolean => {
        const h = step.head;
        if (h.type === "kind" && !n.kinds.includes(h.kind)) return false;
        if (h.type === "address" && n.address !== wantOf(h.address)) return false;
        return step.predicates.every((p) => {
          const v = n.attrs[p.key];
          if (v === undefined) return p.op === "!=";
          if (p.op === "=") return v === p.value;
          if (p.op === "!=") return v !== p.value;
          if (p.op === "^=") return v.startsWith(p.value);
          return v.includes(p.value);
        });
      };
      const isAncestor = (anc: string, n: CoreNode, direct: boolean): boolean => {
        let p = n.parent;
        while (p !== null) {
          if (p === anc) return true;
          if (direct) return false;
          p = byAddress.get(p)?.parent ?? null;
        }
        return false;
      };
      let current: CoreNode[] | null = null;
      for (const step of steps) {
        let next = all.filter((n) => matches(n, step));
        if (current !== null) {
          const prev = current;
          next = next.filter((n) => prev.some((c) => isAncestor(c.address, n, step.combinator === "child")));
        }
        // `page:#n` resolves by index.
        if (step.head.type === "address" && step.head.address.kind === "pageIndex") {
          const page = await resolvePage(step.head.address);
          next = page ? all.filter((n) => n.address === formatAddress({ kind: "page", id: page.selfId })) : [];
        }
        if (step.nth !== undefined) next = next.slice(step.nth - 1, step.nth);
        current = next;
      }
      return (current ?? []).map((n) => n.address);
    },

    async commit(mutations) {
      if (mutations.length === 0) return { applied: true, createdId: null, pageIds: [] };
      const m = mutations.length === 1 ? mutations[0]! : ({ op: "batch", args: { ops: mutations } } as MutationInput);
      try {
        const reply = await client().mutate(m as never);
        if (reply.kind === "mutationApplied") {
          const p = reply.payload;
          return { applied: true, createdId: p.createdId ?? null, pageIds: p.pageIds, ...(p.minted ? { minted: p.minted } : {}) };
        }
        return { applied: false, error: reply.kind === "mutationFailed" ? reply.payload : reply };
      } catch (error) {
        return { applied: false, error };
      }
    },

    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      subscribed = false;
      nodesCache = null;
      listeners.clear();
    },

    invalidate() {
      generation++;
      for (const l of listeners) l();
    },

    onDidChange(listener) {
      ensureSubscribed();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
