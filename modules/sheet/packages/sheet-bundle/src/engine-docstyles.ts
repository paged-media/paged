// The document-style mapping doors (sheet ADR 524): "Use document styles"
// and the table from Excel named styles to document styles. Every method
// forwards to a sheet-js wasm call (the Rust engine folds the mapping into
// the resolved styles); the camelCase facade below is spread into
// `wrapEngine`'s. All methods are optional on the facade so a test fake or
// an older artifact without them stays a valid engine.

/** The document styles one Excel named style maps to (ids). */
export interface DocStyleTarget {
  para?: string | null;
  char?: string | null;
  cell?: string | null;
}

/** The workbook's switch and mapping table, keyed by Excel style name. */
export interface DocStyleMap {
  enabled: boolean;
  entries: Record<string, DocStyleTarget>;
}

/** One Excel named style with its usage and font (Normal first). */
export interface NamedStyleUsage {
  name: string;
  builtinId?: number | null;
  cells: number;
  fontName?: string | null;
  fontSize?: number | null;
  bold: boolean;
  italic: boolean;
  /** `#RRGGBB`. */
  color?: string | null;
}

/** The document styles and swatches the workbook names (id → cells that
 *  name it directly; 0 = only the mapping table names it). */
export interface DocReferences {
  paraStyles: Record<string, number>;
  charStyles: Record<string, number>;
  cellStyles: Record<string, number>;
  swatches: Record<string, number>;
}

export interface SheetEngineDocStyles {
  /** The workbook's document-style mapping. */
  docStyleMap?(): DocStyleMap;
  /** Replace the whole mapping (the undo of any map change). */
  setDocStyleMap?(map: DocStyleMap): void;
  /** Turn "Use document styles" on or off (the table is kept). */
  setDocStylesEnabled?(on: boolean): void;
  /** Map one Excel named style (an empty target clears the entry). */
  setDocStyleMapping?(style: string, target: DocStyleTarget): void;
  /** The workbook's named styles with cell counts and fonts. */
  namedStyleUsage?(): NamedStyleUsage[];
  /** Which document style ids exist (`null` = unknown); whether what the
   *  cells resolve to changed. */
  setDocumentStylesAvailable?(ids: readonly string[] | null): boolean;
  /** Every document style and swatch the workbook names. */
  docReferences?(): DocReferences;
  /** Point every reference to `from` at `to`; how many changed. */
  remapDocReference?(from: string, to: string, model?: string | null): number;
}

export interface SheetWasmEngineDocStyles {
  doc_style_map?(): DocStyleMap;
  set_doc_style_map?(
    enabled: boolean,
    styles: string[],
    para: string[],
    chars: string[],
    cell: string[],
  ): void;
  set_doc_styles_enabled?(on: boolean): void;
  set_doc_style_mapping?(
    style: string,
    para?: string,
    chars?: string,
    cell?: string,
  ): void;
  named_style_usage?(): NamedStyleUsage[];
  set_document_styles_available?(ids: string[] | undefined): boolean;
  doc_references?(): unknown;
  remap_doc_reference?(from: string, to: string, model?: string): number;
}

type Need = (k: keyof SheetWasmEngineDocStyles) => (...a: unknown[]) => unknown;

/** A wasm `Map`-shaped answer (serde-wasm-bindgen serialises a BTreeMap as
 *  a JS `Map`) → a plain record. */
function plainMap(m: unknown): DocStyleMap {
  const raw = m as { enabled?: boolean; entries?: unknown };
  const entries: Record<string, DocStyleTarget> = {};
  const src = raw?.entries;
  const pairs =
    src instanceof Map
      ? [...src.entries()]
      : Object.entries((src ?? {}) as Record<string, unknown>);
  for (const [k, v] of pairs) {
    const t = (v instanceof Map ? Object.fromEntries(v) : v) as DocStyleTarget;
    entries[String(k)] = {
      ...(t.para ? { para: t.para } : {}),
      ...(t.char ? { char: t.char } : {}),
      ...(t.cell ? { cell: t.cell } : {}),
    };
  }
  return { enabled: raw?.enabled === true, entries };
}


export function wrapDocStyles(
  need: Need,
): Required<SheetEngineDocStyles> {
  return {
    docStyleMap: () => plainMap(need("doc_style_map")()),
    setDocStyleMap: (map) => {
      const rows = Object.entries(map.entries);
      need("set_doc_style_map")(
        map.enabled,
        rows.map(([k]) => k),
        rows.map(([, t]) => t.para ?? ""),
        rows.map(([, t]) => t.char ?? ""),
        rows.map(([, t]) => t.cell ?? ""),
      );
    },
    setDocStylesEnabled: (on) => {
      need("set_doc_styles_enabled")(on);
    },
    setDocStyleMapping: (style, target) => {
      need("set_doc_style_mapping")(
        style,
        target.para ?? undefined,
        target.char ?? undefined,
        target.cell ?? undefined,
      );
    },
    namedStyleUsage: () => need("named_style_usage")() as NamedStyleUsage[],
    setDocumentStylesAvailable: (ids) =>
      need("set_document_styles_available")(
        ids === null ? undefined : [...ids],
      ) as boolean,
    docReferences: () => {
      const raw = need("doc_references")() as Record<string, unknown>;
      const rec = (m: unknown): Record<string, number> =>
        m instanceof Map
          ? (Object.fromEntries(m) as Record<string, number>)
          : ((m ?? {}) as Record<string, number>);
      return {
        paraStyles: rec(raw.paraStyles),
        charStyles: rec(raw.charStyles),
        cellStyles: rec(raw.cellStyles),
        swatches: rec(raw.swatches),
      };
    },
    remapDocReference: (from, to, model) =>
      need("remap_doc_reference")(from, to, model ?? undefined) as number,
  };
}
