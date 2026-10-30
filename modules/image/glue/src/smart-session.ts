// SMART OBJECTS in the image session (image ADR 482, WP5.14): the
// transform (numeric, and corner by corner), the smart filters (added by
// any Filter on a smart object, edited, switched, reordered, deleted;
// their filter mask), the contents (Edit Contents as a NESTED document
// with one undo step in the parent, Replace Contents, Relink, Embed,
// Export) and vector smart objects placed from page items.
//
// The session owns one controller (`session.smart()`); it holds only UI
// state. Sources, placements and filters are engine state, every change
// one undo step on the image's undo list. The smart filters' GPU pass
// runs here, through the Filter dialog's own catalogue (`filters.ts`), so
// a smart filter draws exactly what the one-shot filter draws.

import { defineMessages, t } from "@paged-media/strings";
import type { BundleHost } from "@paged-media/plugin-api";

import type { DecodedInfo, ImageEngine, LayerInfo } from "./engine";
import type { FilterContext, FilterId, FilterValues } from "./filters-schema";
import { filterDef, filterDefaults } from "./filters";
import { pageToImage, resolveFrameFit } from "./frame-fit";
import {
  ASSOCIATED_FILTERS,
  IDENTITY_FIELDS,
  transformQuad,
  type Quad,
  type SmartFiltersEdit,
  type SmartInfo,
  type TransformFields,
} from "./smart-engine";

export const SO = defineMessages("image.smart", {
  noImage: "Open an image first (double-click an image frame).",
  notSmart: "The active layer is not a smart object.",
  failed: "{what} failed: {error}",
  transformed: "“{layer}” transformed — re-rendered from its source.",
  filterAdded: "Smart filter “{filter}” added to “{layer}”.",
  filtersEdited: "Smart filters of “{layer}” changed.",
  filtersPending:
    "The smart filters of “{layer}” need WebGPU to run; it shows its unfiltered render until then.",
  maskEdited: "Filter mask of “{layer}” changed.",
  contentsOpen:
    "Editing the contents of “{layer}”. Save and close them to update the smart object.",
  contentsSaved: "Contents of “{layer}” saved: the smart object re-rendered.",
  contentsDiscarded: "Contents closed without saving.",
  replaced: "Contents of “{layer}” replaced with “{file}”.",
  relinked: "“{layer}” relinked to “{file}”.",
  embedded: "“{layer}” embedded.",
  notLinked: "The smart object is not linked to a file.",
  updated: "“{layer}” updated from “{file}”.",
  exported: "Contents of “{layer}” exported as “{file}”.",
  noPicker: "This editor cannot pick files.",
  noSaver: "This editor cannot save files.",
  placed: "Placed {count} page item(s) as the vector smart object “{layer}”.",
  noItems: "Select page items (not the image's own frame) to place.",
  noRender:
    "This editor cannot draw page items for a smart object (render.snapshot@2).",
  rerasterized: "“{layer}” drawn again from its page items at {ppi} ppi.",
  gaussian: "Gaussian blur",
  // Notes from the import.
  kept: "Smart objects that keep Photoshop's render: {notes}",
});

export interface SmartDeps {
  host: BundleHost;
  engine(): ImageEngine | null;
  source(): {
    handle: number;
    width: number;
    height: number;
    elementId: string | null;
  } | null;
  /** Re-point the session at another engine handle (Edit Contents):
   *  the frame keeps showing whatever the session's source is. */
  adoptSource(info: DecodedInfo, nestedName: string | null): void;
  layers(): { active: number; layers: LayerInfo[] };
  gpu(): boolean;
  setStatus(s: string): void;
  emit(): void;
  refreshLayers(): void;
  recomposite(): Promise<boolean>;
  /** The Filter dialog's context (colours, resources) for `values`. */
  filterContext(
    width: number,
    height: number,
    values: FilterValues,
  ): FilterContext;
}

export interface SmartUiState {
  /** The names of the smart objects whose contents are open, outermost
   *  first (empty: the document itself). */
  nested: string[];
}

export interface SmartController {
  state(): SmartUiState;
  /** The state of the smart object `index` (the active layer by
   *  default), or null. */
  info(index?: number): SmartInfo | null;
  isSmart(index?: number): boolean;
  /** Place the source on `quad`. One undo step. */
  place(index: number, quad: Quad): Promise<boolean>;
  /** Transform by numeric fields about the centre (Free Transform's
   *  Scale, Rotate, Skew, Flip and a move). One undo step. */
  transform(index: number, fields: Partial<TransformFields>): Promise<boolean>;
  /** Run every pending smart filter pass (after an undo, a canvas op, a
   *  reopened session), then re-composite. */
  runPending(): Promise<boolean>;
  /** The same passes without the re-composite (the session's fold runs
   *  them first). */
  passPending(): Promise<void>;
  /** Add a smart filter (the Filter dialog's OK on a smart object). */
  addFilter(
    index: number,
    id: FilterId,
    values: FilterValues,
  ): Promise<boolean>;
  /** Edit filter `at` (its values, switch, opacity). */
  setFilter(
    index: number,
    at: number,
    patch: { values?: FilterValues; enabled?: boolean; opacity?: number },
  ): Promise<boolean>;
  removeFilter(index: number, at: number): Promise<boolean>;
  moveFilter(index: number, at: number, to: number): Promise<boolean>;
  /** The eye beside "Smart Filters": every filter on or off. */
  setFiltersEnabled(index: number, on: boolean): Promise<boolean>;
  setFilterMaskEnabled(index: number, on: boolean): Promise<boolean>;
  filterMask(
    index: number,
    op: "selection" | "invert" | "clear" | "hide-all",
  ): Promise<boolean>;
  /** EDIT CONTENTS: open the source as a nested document. */
  openContents(index?: number): Promise<boolean>;
  /** Close the open contents, saving them into the smart object (one
   *  undo step there) or not. */
  closeContents(save: boolean): Promise<boolean>;
  /** Close every open level, saving (before a commit). */
  closeAll(save: boolean): Promise<boolean>;
  replaceContents(index?: number): Promise<boolean>;
  relink(index?: number): Promise<boolean>;
  /** Read a linked object's file again (Update Modified Content): the
   *  file is picked again — a browser cannot reread a path — and the link
   *  keeps its path. */
  updateLinked(index?: number): Promise<boolean>;
  embed(index?: number): Promise<boolean>;
  exportContents(index?: number): Promise<boolean>;
  /** Place the selected page items as a VECTOR smart object. */
  placePageItems(ids?: string[]): Promise<boolean>;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The largest resolution a vector smart object is drawn at. */
const MAX_DPI = 2400;

export function createSmartController(deps: SmartDeps): SmartController {
  const ui: SmartUiState = { nested: [] };
  const active = (i?: number) => i ?? deps.layers().active;
  const nameOf = (i: number) =>
    deps.layers().layers.find((l) => l.index === i)?.name ?? `#${i}`;
  const engineOr = (): ImageEngine | null => {
    const e = deps.engine();
    if (!e || !deps.source()) {
      deps.setStatus(t(SO.noImage));
      deps.emit();
      return null;
    }
    return e;
  };
  const fail = (what: string, err: unknown) => {
    deps.setStatus(t(SO.failed, { what, error: errText(err) }));
    deps.refreshLayers();
    deps.emit();
    return false;
  };

  /** The smart filters' GPU pass over smart object `index`. */
  const runFilters = async (
    e: ImageEngine,
    index: number,
  ): Promise<boolean> => {
    const info = e.smartInfo(index);
    const src = deps.source();
    if (!info || !src) return false;
    if (!deps.gpu()) {
      deps.setStatus(t(SO.filtersPending, { layer: nameOf(index) }));
      return false;
    }
    const live = info.filters?.enabled
      ? info.filters.filters.filter((f) => f.enabled && f.known)
      : [];
    const base = e.smartFilterBase(index);
    let cur = base.handle;
    try {
      for (const f of live) {
        const def = filterDef(f.id as FilterId);
        const values = { ...filterDefaults(def), ...(f.values ?? {}) };
        const ctx = deps.filterContext(base.width, base.height, values);
        // A blur averages ASSOCIATED colour (as Photoshop's smart
        // filters do): a transparent neighbour lends an edge no colour.
        const assoc = ASSOCIATED_FILTERS.has(f.id);
        const input = assoc ? e.smartFilterAssociate(cur, false).handle : cur;
        let out = (await def.run(e, input, values, ctx)).handle;
        if (assoc) {
          const back = e.smartFilterAssociate(out, true).handle;
          if (out !== input) e.freeImage(out);
          e.freeImage(input);
          out = back;
        }
        if (f.opacity < 1) {
          const faded = e.smartFilterFade(cur, out, f.opacity).handle;
          if (out !== cur) e.freeImage(out);
          out = faded;
        }
        if (cur !== base.handle) e.freeImage(cur);
        cur = out;
      }
      e.smartFilterLand(index, base.handle, cur);
      return true;
    } finally {
      if (cur !== base.handle) e.freeImage(cur);
      e.freeImage(base.handle);
    }
  };

  const runPendingNow = async (e: ImageEngine): Promise<void> => {
    for (const i of e.smartPending()) {
      try {
        await runFilters(e, i);
      } catch (err) {
        deps.setStatus(t(SO.failed, { what: nameOf(i), error: errText(err) }));
      }
    }
  };

  /** Run `mutate` (one engine step), then the filter pass it may have
   *  made pending, then re-composite. */
  const step = async (
    what: string,
    mutate: (e: ImageEngine) => unknown,
    done?: string,
  ): Promise<boolean> => {
    const e = engineOr();
    if (!e) return false;
    try {
      await mutate(e);
      await runPendingNow(e);
    } catch (err) {
      return fail(what, err);
    }
    deps.refreshLayers();
    const ok = await deps.recomposite();
    if (ok && done) deps.setStatus(done);
    deps.emit();
    return ok;
  };

  const editOf = (info: SmartInfo): SmartFiltersEdit => ({
    enabled: info.filters?.enabled ?? true,
    maskEnabled: info.filters?.maskEnabled ?? true,
    filters: (info.filters?.filters ?? []).map((f, i) => ({
      id: f.id,
      name: f.name,
      values: f.values ?? {},
      enabled: f.enabled,
      opacity: f.opacity,
      mode: f.mode,
      from: i,
    })),
  });

  const editFilters = async (
    index: number,
    label: string,
    change: (edit: SmartFiltersEdit) => void,
    done: string,
  ): Promise<boolean> => {
    const e = engineOr();
    if (!e) return false;
    const info = e.smartInfo(index);
    if (!info) {
      deps.setStatus(t(SO.notSmart));
      deps.emit();
      return false;
    }
    const edit = editOf(info);
    change(edit);
    return step(label, (en) => en.smartSetFilters(label, index, edit), done);
  };

  /** A vector smart object grown past its source's resolution: its page
   *  items drawn again at what the placement needs. */
  const rerasterize = async (e: ImageEngine, index: number): Promise<void> => {
    const info = e.smartInfo(index);
    const v = info?.vector;
    if (!info || !v || info.scale <= 1.01) return;
    const host = deps.host;
    if (!host.supports("render.snapshot@2")) return;
    const pxPerPt = Math.min(MAX_DPI / 72, v.pxPerPt * info.scale);
    const geom = await host.document.elementGeometry(
      v.items.map((id) => ({ kind: "rectangle", id }) as never),
    );
    const pageId = geom.find((g) => g.pageId)?.pageId;
    if (!pageId) return;
    const shot = await host.render.snapshot(pageId, {
      dpi: pxPerPt * 72,
      only: v.items as never,
      clip: {
        x: v.region[0]!,
        y: v.region[1]!,
        width: v.region[2]!,
        height: v.region[3]!,
      },
      format: "rgba",
      background: "transparent",
    });
    if (!shot?.rgba) return;
    e.smartVectorSource(index, shot.rgba, shot.widthPx, shot.heightPx, pxPerPt);
    deps.setStatus(
      t(SO.rerasterized, {
        layer: nameOf(index),
        ppi: Math.round(pxPerPt * 72),
      }),
    );
  };

  const pick = async (): Promise<{
    name: string;
    bytes: Uint8Array;
  } | null> => {
    const host = deps.host;
    if (!host.supports("shell.pickFile@1")) {
      deps.setStatus(t(SO.noPicker));
      deps.emit();
      return null;
    }
    const picked = await host.shell.pickFile({
      accept: [
        ".psd",
        ".psb",
        ".png",
        ".jpg",
        ".jpeg",
        ".tif",
        ".tiff",
        ".webp",
      ],
    });
    return picked[0] ?? null;
  };

  return {
    state: () => ui,

    info(index) {
      const e = deps.engine();
      if (!e || !deps.source()) return null;
      return e.smartInfo(active(index));
    },

    isSmart(index) {
      const i = active(index);
      return deps.layers().layers.find((l) => l.index === i)?.kind === "smart";
    },

    place(index, quad) {
      return step(
        "transform",
        async (e) => {
          e.smartTransform(index, quad);
          await rerasterize(e, index);
        },
        t(SO.transformed, { layer: nameOf(index) }),
      );
    },

    async transform(index, fields) {
      const info = this.info(index);
      if (!info) {
        deps.setStatus(t(SO.notSmart));
        deps.emit();
        return false;
      }
      const q = transformQuad(info.quad as unknown as Quad, {
        ...IDENTITY_FIELDS,
        ...fields,
      });
      return this.place(index, q);
    },

    async runPending() {
      const e = deps.engine();
      if (!e || !deps.source() || e.smartPending().length === 0) return true;
      await runPendingNow(e);
      deps.refreshLayers();
      return deps.recomposite();
    },

    async passPending() {
      const e = deps.engine();
      if (e && deps.source()) await runPendingNow(e);
    },

    addFilter(index, id, values) {
      const def = filterDef(id);
      return editFilters(
        index,
        "Smart Filters",
        (edit) => {
          edit.filters.push({
            id,
            name: t(def.label),
            values: { ...filterDefaults(def), ...values },
            enabled: true,
            opacity: 1,
            mode: "normal",
          });
        },
        t(SO.filterAdded, { filter: t(def.label), layer: nameOf(index) }),
      );
    },

    setFilter(index, at, patch) {
      return editFilters(
        index,
        "Smart Filters",
        (edit) => {
          const f = edit.filters[at];
          if (!f) return;
          if (patch.values) f.values = { ...f.values, ...patch.values };
          if (patch.enabled !== undefined) f.enabled = patch.enabled;
          if (patch.opacity !== undefined)
            f.opacity = Math.min(1, Math.max(0, patch.opacity));
        },
        t(SO.filtersEdited, { layer: nameOf(index) }),
      );
    },

    removeFilter(index, at) {
      return editFilters(
        index,
        "Delete Smart Filter",
        (edit) => {
          edit.filters.splice(at, 1);
        },
        t(SO.filtersEdited, { layer: nameOf(index) }),
      );
    },

    moveFilter(index, at, to) {
      return editFilters(
        index,
        "Smart Filters",
        (edit) => {
          const [f] = edit.filters.splice(at, 1);
          if (f)
            edit.filters.splice(
              Math.max(0, Math.min(to, edit.filters.length)),
              0,
              f,
            );
        },
        t(SO.filtersEdited, { layer: nameOf(index) }),
      );
    },

    setFiltersEnabled(index, on) {
      return editFilters(
        index,
        on ? "Enable Smart Filters" : "Disable Smart Filters",
        (edit) => {
          edit.enabled = on;
        },
        t(SO.filtersEdited, { layer: nameOf(index) }),
      );
    },

    setFilterMaskEnabled(index, on) {
      return editFilters(
        index,
        on ? "Enable Filter Mask" : "Disable Filter Mask",
        (edit) => {
          edit.maskEnabled = on;
        },
        t(SO.maskEdited, { layer: nameOf(index) }),
      );
    },

    filterMask(index, op) {
      return step(
        "filter mask",
        (e) => e.smartFilterMask(index, op),
        t(SO.maskEdited, { layer: nameOf(index) }),
      );
    },

    async openContents(index) {
      const e = engineOr();
      if (!e) return false;
      const i = active(index);
      const name = nameOf(i);
      let nested: DecodedInfo;
      try {
        nested = await e.smartContentsOpen(i);
      } catch (err) {
        return fail("Edit Contents", err);
      }
      ui.nested = [...ui.nested, name];
      deps.adoptSource(nested, name);
      deps.refreshLayers();
      await runPendingNow(e);
      const ok = await deps.recomposite();
      deps.setStatus(t(SO.contentsOpen, { layer: name }));
      deps.emit();
      return ok;
    },

    async closeContents(save) {
      const e = engineOr();
      if (!e || ui.nested.length === 0) return false;
      const name = ui.nested[ui.nested.length - 1]!;
      let parent: DecodedInfo;
      try {
        parent = await e.smartContentsClose(save);
      } catch (err) {
        return fail("Close Contents", err);
      }
      ui.nested = ui.nested.slice(0, -1);
      deps.adoptSource(parent, ui.nested[ui.nested.length - 1] ?? null);
      deps.refreshLayers();
      await runPendingNow(e);
      deps.refreshLayers();
      const ok = await deps.recomposite();
      deps.setStatus(
        save ? t(SO.contentsSaved, { layer: name }) : t(SO.contentsDiscarded),
      );
      deps.emit();
      return ok;
    },

    async closeAll(save) {
      while (ui.nested.length > 0) {
        if (!(await this.closeContents(save))) return false;
      }
      return true;
    },

    async replaceContents(index) {
      if (!engineOr()) return false;
      const i = active(index);
      if (!this.isSmart(i)) {
        deps.setStatus(t(SO.notSmart));
        deps.emit();
        return false;
      }
      const file = await pick();
      if (!file) return false;
      return step(
        "Replace Contents",
        (e) => e.smartReplace(i, file.bytes, file.name),
        t(SO.replaced, { layer: nameOf(i), file: file.name }),
      );
    },

    async relink(index) {
      if (!engineOr()) return false;
      const i = active(index);
      if (!this.isSmart(i)) {
        deps.setStatus(t(SO.notSmart));
        deps.emit();
        return false;
      }
      const file = await pick();
      if (!file) return false;
      return step(
        "Relink",
        (e) => e.smartReplace(i, file.bytes, file.name, file.name),
        t(SO.relinked, { layer: nameOf(i), file: file.name }),
      );
    },

    async updateLinked(index) {
      const e = engineOr();
      if (!e) return false;
      const i = active(index);
      const info = e.smartInfo(i);
      if (!info?.file?.linked) {
        deps.setStatus(t(SO.notLinked));
        deps.emit();
        return false;
      }
      const file = await pick();
      if (!file) return false;
      const path = info.file.path ?? file.name;
      return step(
        "Update Modified Content",
        (en) => en.smartReplace(i, file.bytes, info.file!.name, path),
        t(SO.updated, { layer: nameOf(i), file: file.name }),
      );
    },

    embed(index) {
      const i = active(index);
      return step(
        "Embed Linked",
        (e) => e.smartEmbed(i),
        t(SO.embedded, { layer: nameOf(i) }),
      );
    },

    async exportContents(index) {
      const e = engineOr();
      if (!e) return false;
      const i = active(index);
      const info = e.smartInfo(i);
      if (!info) {
        deps.setStatus(t(SO.notSmart));
        deps.emit();
        return false;
      }
      if (!deps.host.supports("shell.saveFile@1")) {
        deps.setStatus(t(SO.noSaver));
        deps.emit();
        return false;
      }
      let bytes: Uint8Array;
      try {
        bytes = e.smartContents(i);
      } catch (err) {
        return fail("Export Contents", err);
      }
      const name = info.file?.name || `${nameOf(i)}.png`;
      const ok = await deps.host.shell.saveFile({
        suggestedName: name,
        bytes,
        mimeType: name.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
      });
      if (ok) deps.setStatus(t(SO.exported, { layer: nameOf(i), file: name }));
      deps.emit();
      return ok;
    },

    async placePageItems(ids) {
      const e = engineOr();
      const src = deps.source();
      if (!e || !src) return false;
      const host = deps.host;
      if (!host.supports("render.snapshot@2")) {
        deps.setStatus(t(SO.noRender));
        deps.emit();
        return false;
      }
      const items = (
        ids ??
        host.selection.get().map((i) => String((i as { id?: unknown }).id ?? i))
      ).filter((id) => id !== src.elementId);
      if (items.length === 0) {
        deps.setStatus(t(SO.noItems));
        deps.emit();
        return false;
      }
      const fit = await resolveFrameFit(host, src, "place");
      if (!fit) {
        deps.setStatus(t(SO.noItems));
        deps.emit();
        return false;
      }
      // The image's own resolution on the page: px per pt.
      const pxPerPt = Math.min(MAX_DPI / 72, 1 / fit.scale);
      const shot = await host.render.snapshot(fit.pageId as never, {
        dpi: pxPerPt * 72,
        only: items as never,
        format: "rgba",
        background: "transparent",
        trim: true,
      });
      if (!shot?.rgba || !shot.region) {
        deps.setStatus(t(SO.noItems));
        deps.emit();
        return false;
      }
      const r = shot.region;
      // Where the items lie over the image, in image px.
      const [x0, y0] = pageToImage(fit, [r.x, r.y]);
      const [x1, y1] = pageToImage(fit, [r.x + r.width, r.y + r.height]);
      const quad: Quad = [x0, y0, x1, y0, x1, y1, x0, y1];
      const name = `Vector Smart Object`;
      return step(
        "Place as smart object",
        (en) =>
          en.smartAdd(name, shot.rgba!, shot.widthPx, shot.heightPx, quad, {
            items,
            region: [r.x, r.y, r.width, r.height],
            pxPerPt,
          }),
        t(SO.placed, { count: items.length, layer: name }),
      );
    },
  };
}
