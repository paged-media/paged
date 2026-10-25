// Editor ADR 291: a grid row of the Data panel dropped on a design — a group
// or a single frame — fills it with that record. Every `<<field>>` written in
// its text frames, as Data Merge reads them, becomes a variable bound to the
// record's field; a graphic frame named `<<@photo>>` (or `<<photo>>`) gets
// an image binding over `photo`. The placeholders are found by the engine
// (`placeholder_spans`, data-lower's merge reader) and every binding
// resolves at that record (`resolve_lowered_at`); this module only reads the
// design and writes what the engine answered.
//
// And the first run's sample data: a tiny product list made here (no file,
// no network, nothing licensed), loaded as a source with a query over it.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import type { DataEngineLike } from "./engine";
import { commitSpanVariables } from "./lower";
import { storyText } from "./merge";

/** What the record drop needs of the session. */
export interface RecordDropDeps {
  host: BundleHost;
  engine(): Promise<DataEngineLike>;
  addVariableBinding(
    id: string,
    target: string,
    query: string,
    expr: string,
  ): void;
  addImageBinding(
    id: string,
    target: string,
    query: string,
    expr: string,
  ): void;
  /** Resolve binding `id` at `record` from now on (and save that). */
  fixRecord(id: string, record: number): void;
  /** The variable's field is in the document (no second placement). */
  placed(id: string): void;
  lowerBinding(id: string): Promise<void>;
  removeBinding(id: string): Promise<boolean>;
}

interface Span {
  start: number;
  end: number;
  field: string;
  image: boolean;
}

interface TreeNode {
  id?: ElementId | null;
  kind: string;
  label?: string;
  children?: readonly TreeNode[];
}

const GRAPHIC = new Set(["rectangle", "oval", "polygon"]);

/** The page items of the design `target` names (a group's members, all the
 *  way down; or the item itself), with their names. */
function membersOf(
  tree: readonly TreeNode[],
  target: ElementId,
): { id: ElementId; label: string }[] {
  const same = (n: TreeNode) =>
    n.id?.kind === target.kind && String(n.id.id) === String(target.id);
  const out: { id: ElementId; label: string }[] = [];
  const collect = (n: TreeNode) => {
    if (n.id && (n.id.kind === "textFrame" || GRAPHIC.has(n.id.kind)))
      out.push({ id: n.id, label: n.label ?? "" });
    for (const c of n.children ?? []) collect(c);
  };
  const find = (nodes: readonly TreeNode[]): boolean => {
    for (const n of nodes) {
      if (same(n)) {
        collect(n);
        return true;
      }
      if (n.children && find(n.children)) return true;
    }
    return false;
  };
  if (!find(tree) && target.kind === "textFrame")
    out.push({ id: target, label: "" });
  return out;
}

let seq = 0;

/** Fill the design `target` with record `record` of `query`. */
export async function placeRecordOn(
  d: RecordDropDeps,
  query: string,
  record: number,
  target: ElementId,
): Promise<{ binding: string; kind: string }[]> {
  if (target.kind !== "group" && target.kind !== "textFrame")
    if (!GRAPHIC.has(String(target.kind)))
      throw new Error(
        `a record fills a group or a frame, not a ${String(target.kind)}`,
      );
  const e = await d.engine();
  if (
    typeof e.placeholder_spans !== "function" ||
    typeof e.resolve_lowered_at !== "function"
  )
    throw new Error(
      "this data engine cannot read <<field>> placeholders (rebuild it)",
    );
  const spansOf = (text: string) =>
    (e.placeholder_spans!(text) as Span[] | null) ?? [];
  const members = membersOf(
    (await d.host.document.tree()) as readonly TreeNode[],
    target,
  );
  const stamp = `${Date.now().toString(36)}-${++seq}`;
  const made: { binding: string; kind: string }[] = [];
  const key = (field: string) =>
    `${field.replace(/[^A-Za-z0-9_]/g, "_")}-r${record + 1}-${stamp}-${made.length}`;

  // Text frames: their stories (a threaded story once), each `<<field>>`.
  const frames = members.filter((m) => m.id.kind === "textFrame");
  const geoms =
    frames.length > 0
      ? await d.host.document.elementGeometry(frames.map((f) => f.id))
      : [];
  const stories = new Set<string>();
  const writes: {
    storyId: string;
    start: number;
    end: number;
    key: string;
    value: string | null;
  }[] = [];
  try {
    for (const g of geoms) {
      const storyId = (g as { storyId?: string | null }).storyId;
      if (!storyId || stories.has(storyId)) continue;
      stories.add(storyId);
      const content = await d.host.document.storyContent(storyId);
      if (!content) continue;
      for (const s of spansOf(storyText(content))) {
        if (s.image) continue;
        const id = key(s.field);
        d.addVariableBinding(id, id, query, s.field);
        d.fixRecord(id, record);
        made.push({ binding: id, kind: "variable" });
        const lowered = e.resolve_lowered_at!(id, record) as {
          kind?: string;
          text?: string;
          hidden?: boolean;
        } | null;
        if (lowered?.kind !== "variable")
          throw new Error(
            `the field ${s.field} does not resolve (refresh the data first)`,
          );
        writes.push({
          storyId,
          start: s.start,
          end: s.end,
          key: id,
          value: lowered.hidden ? null : (lowered.text ?? ""),
        });
      }
    }
    // Graphic frames named as a field: its picture.
    const pictures: string[] = [];
    for (const m of members) {
      if (!GRAPHIC.has(m.id.kind)) continue;
      const label = m.label.trim();
      const spans = spansOf(label);
      if (spans.length !== 1 || spans[0]!.start !== 0) continue;
      if (spans[0]!.end !== new TextEncoder().encode(label).length) continue;
      const id = key(spans[0]!.field);
      d.addImageBinding(id, String(m.id.id), query, spans[0]!.field);
      d.fixRecord(id, record);
      made.push({ binding: id, kind: "image" });
      pictures.push(id);
    }
    if (made.length === 0)
      throw new Error(
        "the design holds no <<field>> to fill: write one in a text frame (Price: <<price>>), or name a graphic frame <<@field>>",
      );
    if (writes.length > 0) {
      if (!(await commitSpanVariables(d.host, writes)))
        throw new Error("the fields could not be placed");
      for (const w of writes) d.placed(w.key);
    }
    for (const id of pictures) await d.lowerBinding(id);
  } catch (err) {
    for (const m of made) await d.removeBinding(m.binding);
    throw err;
  }
  return made;
}

/** The sample's source table and query names. */
export const SAMPLE_SOURCE = "sample_products";
export const SAMPLE_QUERY = "sample";

/** The sample products, as CSV: made up here, free to use. */
export function sampleCsv(): string {
  const rows: [string, string, string, number][] = [
    ["P-100", "Desk lamp", "Lighting", 39.9],
    ["P-101", "Floor lamp", "Lighting", 89],
    ["P-200", "Oak chair", "Seating", 129],
    ["P-201", "Linen sofa", "Seating", 749],
    ["P-300", "Wall shelf", "Storage", 45.5],
    ["P-301", "Sideboard", "Storage", 389],
    ["P-400", "Wool rug", "Textiles", 210],
    ["P-401", "Cushion", "Textiles", 24.9],
  ];
  return [
    "sku,name,category,price",
    ...rows.map((r) => `${r[0]},${r[1]},${r[2]},${r[3].toFixed(2)}`),
  ].join("\n");
}

export const SAMPLE_SQL = `SELECT sku, name, category, price FROM ${SAMPLE_SOURCE} ORDER BY sku`;
