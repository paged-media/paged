// The WORKSPACE doors of the engine facade (WP5.12, image ADR 475): the
// image's ruler guides, the Count tool's marks and groups, the Note
// tool's annotations and the Slice tool's rectangles, and the PSD
// grid-and-guides resource (id 1032). Every verb is one undo step on the
// image's own list (image-js/src/workspace.rs, layers/workspace_ops.rs).
// `ImageEngine` / `ImageWasmModule` extend these interfaces and
// `wrapEngine` spreads `workspaceEngine` in.

/** One ruler guide, in image px. */
export interface WorkspaceGuideInfo {
  orientation: "horizontal" | "vertical";
  position: number;
}

/** One count group: its own numbering from 1, its own colour. */
export interface CountGroupInfo {
  name: string;
  color: [number, number, number];
  visible: boolean;
  marks: [number, number][];
}

export interface NoteInfo {
  at: [number, number];
  author: string;
  text: string;
}

export interface SliceInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

/** `layers_workspace`. */
export interface WorkspaceInfo {
  guides: WorkspaceGuideInfo[];
  counts: CountGroupInfo[];
  activeCount: number;
  notes: NoteInfo[];
  slices: SliceInfo[];
}

export const EMPTY_WORKSPACE: WorkspaceInfo = {
  guides: [],
  counts: [],
  activeCount: 0,
  notes: [],
  slices: [],
};

/** The raw wasm doors (`image_js.d.ts`). */
export interface WorkspaceWasm {
  layers_workspace(): string;
  layers_guide_add(vertical: boolean, position: number): number;
  layers_guide_move(index: number, position: number): boolean;
  layers_guide_delete(index: number): void;
  layers_guides_clear(): boolean;
  layers_count_add(x: number, y: number): number;
  layers_count_move(
    group: number,
    index: number,
    x: number,
    y: number,
  ): boolean;
  layers_count_remove(group: number, index: number): void;
  layers_count_clear(group: number): boolean;
  layers_count_group_new(name: string): number;
  layers_count_group_active(group: number): boolean;
  layers_count_group_set(
    group: number,
    name: string,
    r: number,
    g: number,
    b: number,
    visible: number,
  ): boolean;
  layers_count_group_delete(group: number): void;
  layers_note_add(x: number, y: number, author: string, text: string): number;
  layers_note_edit(index: number, author: string, text: string): boolean;
  layers_note_move(index: number, x: number, y: number): boolean;
  layers_note_delete(index: number): void;
  layers_notes_clear(): boolean;
  layers_slice_add(
    x: number,
    y: number,
    w: number,
    h: number,
    name: string,
  ): number;
  layers_slice_set(
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    name: string,
  ): boolean;
  layers_slice_delete(index: number): void;
  layers_slices_clear(): boolean;
  layers_slices_from_guides(): number;
  layers_adopt_psd_guides(psdHandle: number): number;
  psd_write_guides(psdHandle: number): boolean;
}

/** The camelCase facade. */
export interface WorkspaceEngine {
  workspace(): WorkspaceInfo;
  guideAdd(orientation: "horizontal" | "vertical", position: number): number;
  guideMove(index: number, position: number): boolean;
  guideDelete(index: number): void;
  guidesClear(): boolean;
  countAdd(at: [number, number]): number;
  countMove(group: number, index: number, at: [number, number]): boolean;
  countRemove(group: number, index: number): void;
  countClear(group: number): boolean;
  countGroupNew(name?: string): number;
  countGroupActive(group: number): boolean;
  countGroupSet(
    group: number,
    patch: {
      name?: string;
      color?: [number, number, number];
      visible?: boolean;
    },
  ): boolean;
  countGroupDelete(group: number): void;
  noteAdd(at: [number, number], author: string, text: string): number;
  noteEdit(index: number, author: string, text: string): boolean;
  noteMove(index: number, at: [number, number]): boolean;
  noteDelete(index: number): void;
  notesClear(): boolean;
  sliceAdd(
    rect: { x: number; y: number; w: number; h: number },
    name?: string,
  ): number;
  sliceSet(
    index: number,
    rect: { x: number; y: number; w: number; h: number },
    name?: string,
  ): boolean;
  sliceDelete(index: number): void;
  slicesClear(): boolean;
  slicesFromGuides(): number;
  adoptPsdGuides(psdHandle: number): number;
  psdWriteGuides(psdHandle: number): boolean;
}

export function workspaceEngine(wasm: WorkspaceWasm): WorkspaceEngine {
  return {
    workspace: () => JSON.parse(wasm.layers_workspace()) as WorkspaceInfo,
    guideAdd: (o, p) => wasm.layers_guide_add(o === "vertical", p),
    guideMove: (i, p) => wasm.layers_guide_move(i, p),
    guideDelete: (i) => wasm.layers_guide_delete(i),
    guidesClear: () => wasm.layers_guides_clear(),
    countAdd: (at) => wasm.layers_count_add(at[0], at[1]),
    countMove: (g, i, at) => wasm.layers_count_move(g, i, at[0], at[1]),
    countRemove: (g, i) => wasm.layers_count_remove(g, i),
    countClear: (g) => wasm.layers_count_clear(g),
    countGroupNew: (name) => wasm.layers_count_group_new(name ?? ""),
    countGroupActive: (g) => wasm.layers_count_group_active(g),
    countGroupSet: (g, patch) =>
      wasm.layers_count_group_set(
        g,
        patch.name ?? "",
        patch.color?.[0] ?? -1,
        patch.color?.[1] ?? -1,
        patch.color?.[2] ?? -1,
        patch.visible === undefined ? -1 : patch.visible ? 1 : 0,
      ),
    countGroupDelete: (g) => wasm.layers_count_group_delete(g),
    noteAdd: (at, author, text) =>
      wasm.layers_note_add(at[0], at[1], author, text),
    noteEdit: (i, author, text) => wasm.layers_note_edit(i, author, text),
    noteMove: (i, at) => wasm.layers_note_move(i, at[0], at[1]),
    noteDelete: (i) => wasm.layers_note_delete(i),
    notesClear: () => wasm.layers_notes_clear(),
    sliceAdd: (r, name) =>
      wasm.layers_slice_add(
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.w),
        Math.round(r.h),
        name ?? "",
      ),
    sliceSet: (i, r, name) =>
      wasm.layers_slice_set(
        i,
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.w),
        Math.round(r.h),
        name ?? "",
      ),
    sliceDelete: (i) => wasm.layers_slice_delete(i),
    slicesClear: () => wasm.layers_slices_clear(),
    slicesFromGuides: () => wasm.layers_slices_from_guides(),
    adoptPsdGuides: (h) => wasm.layers_adopt_psd_guides(h),
    psdWriteGuides: (h) => wasm.psd_write_guides(h),
  };
}
