// Sheet ADR 524 — the document's styles for a workbook's Excel named
// styles. The ENGINE folds the mapping into every resolved cell style (page,
// grid and charts alike); this module is the host side of it: reading the
// document's style lists, the default mapping by name, what the workbook
// names that the document no longer has, and the document styles "Create
// document styles from workbook" mints. Pure functions over plain data,
// plus the one host read.

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import {
  normalizePaletteHex,
  styleProps,
  swatchMintOps,
  type KnownSwatchIds,
} from "../../sheet-host-model/src";
import type {
  DocReferences,
  DocStyleMap,
  DocStyleTarget,
  NamedStyleUsage,
} from "./engine-docstyles";

/** One document style: its id and the name the style panels show. */
export interface DocStyleRow {
  id: string;
  name: string;
}

/** The document's paragraph, character and cell styles and swatch ids. */
export interface DocumentStyleLists {
  paragraph: DocStyleRow[];
  character: DocStyleRow[];
  cell: DocStyleRow[];
  swatches: string[];
}

/** The Excel style that maps the un-named cells. */
export const NORMAL_STYLE = "Normal";

/** The IDML styles un-styled story text falls back to, in order: the basic
 *  paragraph style, else the root "no paragraph style". */
export const BASIC_PARAGRAPH_STYLE_IDS = [
  "ParagraphStyle/$ID/NormalParagraphStyle",
  "ParagraphStyle/$ID/[No paragraph style]",
] as const;

/** Read the document's style lists (null when the read failed — then
 *  nothing is pre-filled, minted or reported missing). */
export async function readDocumentStyleLists(
  host: BundleHost,
): Promise<DocumentStyleLists | null> {
  try {
    type Row = { selfId: string; name?: string };
    const rows = (r: readonly Row[]) =>
      r.map((x) => ({ id: x.selfId, name: x.name || x.selfId }));
    const [p, c, cell, sw] = await Promise.all([
      host.document.collection<Row>("paragraphStyles"),
      host.document.collection<Row>("characterStyles"),
      host.document.collection<Row>("cellStyles"),
      host.document.collection<Row>("swatches"),
    ]);
    return {
      paragraph: rows(p),
      character: rows(c),
      cell: rows(cell),
      swatches: sw.map((s) => s.selfId),
    };
  } catch (err) {
    host.log.warn("document styles: style read failed", err);
    return null;
  }
}

/** Every style id the document has (what the engine may name). */
export function availableStyleIds(lists: DocumentStyleLists): string[] {
  return [
    ...lists.paragraph.map((s) => s.id),
    ...lists.character.map((s) => s.id),
    ...lists.cell.map((s) => s.id),
  ];
}

/** A style's name for matching: case, `$ID/` and brackets ignored. */
const nameKey = (name: string) =>
  name
    .replace(/^.*\$ID\//, "")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();

/** The document's basic paragraph style id, if it has one. */
export function basicParagraphStyle(
  lists: DocumentStyleLists,
): string | undefined {
  const ids = new Set(lists.paragraph.map((s) => s.id));
  return BASIC_PARAGRAPH_STYLE_IDS.find((id) => ids.has(id));
}

/** The entries "Use document styles" pre-fills (only for styles without
 *  one): an Excel style whose name matches a document paragraph style's
 *  (case-insensitive, "Heading 1" ↔ "heading 1"), and Normal → the
 *  document's basic paragraph style. */
export function defaultDocStyleEntries(
  usage: readonly NamedStyleUsage[],
  lists: DocumentStyleLists,
  map: DocStyleMap,
): Record<string, DocStyleTarget> {
  const out: Record<string, DocStyleTarget> = {};
  const has = (name: string) =>
    Object.keys(map.entries).some(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
  for (const u of usage) {
    if (has(u.name)) continue;
    if (u.name === NORMAL_STYLE) {
      const basic = basicParagraphStyle(lists);
      if (basic) out[u.name] = { para: basic };
      continue;
    }
    const want = nameKey(u.name);
    const hit = lists.paragraph.find((p) => nameKey(p.name) === want);
    if (hit) out[u.name] = { para: hit.id };
  }
  return out;
}

/** One reference the document can no longer resolve. */
export interface MissingReference {
  kind: "paragraph" | "character" | "cell" | "swatch";
  id: string;
  /** Cells naming it directly (0 = only the mapping table does). */
  cells: number;
}

/** What the workbook names that the document does not have. The cells
 *  keep showing the workbook's concrete values for them. */
export function missingDocReferences(
  refs: DocReferences,
  lists: DocumentStyleLists,
): MissingReference[] {
  const out: MissingReference[] = [];
  const scan = (
    kind: MissingReference["kind"],
    named: Record<string, number>,
    have: readonly string[],
  ) => {
    const set = new Set(have);
    for (const [id, cells] of Object.entries(named))
      if (!set.has(id)) out.push({ kind, id, cells });
  };
  scan(
    "paragraph",
    refs.paraStyles,
    lists.paragraph.map((s) => s.id),
  );
  scan(
    "character",
    refs.charStyles,
    lists.character.map((s) => s.id),
  );
  scan(
    "cell",
    refs.cellStyles,
    lists.cell.map((s) => s.id),
  );
  scan("swatch", refs.swatches, lists.swatches);
  return out;
}

/** The ops "Create document styles from workbook" applies and the entries
 *  it maps: one paragraph style per Excel named style the cells use that
 *  has no entry, carrying the style's face, size, bold / italic and colour
 *  (a document swatch, minted when the document lacks it), based on the
 *  basic paragraph style. A name the document already uses is mapped to,
 *  never minted twice. */
export function createDocStylesPlan(
  usage: readonly NamedStyleUsage[],
  map: DocStyleMap,
  lists: DocumentStyleLists,
  knownSwatches: KnownSwatchIds,
): { ops: Mutation[]; entries: Record<string, DocStyleTarget> } {
  const mapped = new Set(Object.keys(map.entries).map((k) => k.toLowerCase()));
  const ids = new Set(lists.paragraph.map((p) => p.id));
  const basic = basicParagraphStyle(lists);
  const ops: Mutation[] = [];
  const entries: Record<string, DocStyleTarget> = {};
  const hexes: string[] = [];
  for (const u of usage) {
    if (u.cells === 0 || mapped.has(u.name.toLowerCase())) continue;
    const existing = lists.paragraph.find(
      (p) => nameKey(p.name) === nameKey(u.name),
    );
    if (existing) {
      entries[u.name] = { para: existing.id };
      continue;
    }
    let id = `ParagraphStyle/${u.name}`;
    for (let n = 2; ids.has(id); n++) id = `ParagraphStyle/${u.name} ${n}`;
    ids.add(id);
    const hex = u.color ? normalizePaletteHex(u.color) : null;
    if (hex && !hexes.includes(hex)) hexes.push(hex);
    ops.push({
      op: "createParagraphStyle",
      args: { selfId: id, name: u.name, ...(basic ? { basedOn: basic } : {}) },
    });
    for (const p of styleProps({
      key: 0,
      bold: u.bold,
      italic: u.italic,
      fontName: u.fontName ?? null,
      fontSizePt: u.fontSize ?? null,
      textRgb: hex ? `#${hex}` : null,
    } as Parameters<typeof styleProps>[0])) {
      ops.push({
        op: "setStyleProperty",
        args: {
          collection: "paragraph",
          styleId: id,
          path: p.path,
          value: p.value,
        },
      });
    }
    entries[u.name] = { para: id };
  }
  // The colours the new styles name, minted first (absent ones only; a
  // failed swatch read mints none and the styles keep the default colour).
  const known = knownSwatches === null ? null : new Set(knownSwatches ?? []);
  const mints = swatchMintOps("cellText", hexes, known);
  const kept =
    known === null
      ? ops.filter(
          (op) =>
            !(
              op.op === "setStyleProperty" &&
              (op.args as { path: string }).path === "characterFillColor"
            ),
        )
      : ops;
  return { ops: [...mints, ...kept], entries };
}
