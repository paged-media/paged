// The session's HISTORY SNAPSHOTS and PRESET MANAGER verbs (image ADR
// 477), split from `session.ts` and wired into it through a small
// context. The models are `preset-library.ts` (pure) and the stores
// `preset-store.ts`; the files are the engine's (`presets_*`, paged-psd).

import type { BundleHost } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import { cloneDynamics } from "./brush-dynamics";
import {
  deserializePresets,
  serializePresets,
  type UserBrushPreset,
} from "./brush-presets";
import type { ImageEngine, PatternPresetMeta } from "./engine";
import { cloneStyle, type LayerStyle, type StylePreset } from "./layer-style";
import {
  appendEntries,
  deleteEntry,
  freshId,
  gradientEnds,
  moveEntry,
  parseLibrary,
  renameEntry,
  serializeLibrary,
  untitledPreset,
  type AdjustmentPreset,
  type GradientPreset,
  type PatternPreset,
  type PresetEntry,
  type PresetKind,
  type ToolPreset,
} from "./preset-library";
import {
  clampHistoryPrefs,
  loadHistoryPrefs,
  loadPresets,
  savePresets,
  saveHistoryPrefs,
  type HistoryPrefs,
  type StoredPresets,
} from "./preset-store";
import type { ImageSession, ImageSessionState } from "./session";

const P = defineMessages("image.presetManager", {
  applied: "Applied the preset “{name}”.",
  saved: "Saved the preset “{name}”.",
  noSuch: "No such preset.",
  imported:
    "{count, plural, one {Imported # preset} other {Imported # presets}} from {name}.",
  importedSkipped:
    "{count, plural, one {Imported # preset} other {Imported # presets}} from {name}; {skipped} not read: {why}.",
  importFailed: "Could not import {name}: {error}",
  exported: "Exported {count} presets to {name}.",
  exportFailed: "Could not export: {error}",
  exportDeclined: "The export was not saved.",
  nothingToExport: "There are no presets of this kind to export.",
  noPicker: "This host wires no file picker.",
  noSaver: "This host cannot save files.",
  noEngine: "The image engine is not available.",
  chosenNothing: "No file was chosen.",
  sessionOnlyBrushes:
    "The brush presets are kept for this session only: without a binary store they are too large to keep.",
  sessionOnlyPatterns:
    "The patterns are kept for this session only: without a binary store they are too large to keep.",
  gradientEnds:
    "The gradient tool draws two colours: foreground and background are now the ends of “{name}”; the stops between them stay in the preset.",
  noPattern: "No pattern defined — use Define pattern first.",
  noStyle: "The active layer has no style to save.",
  patternUsed: "“{name}” is now the defined pattern ({w}×{h} px).",
  noLayerForStyle: "Open an image to apply a style.",
});

const H = defineMessages("image.historySnapshots", {
  opened: "Opened",
  snapshotName: "Snapshot {n}",
  taken: "Snapshot “{name}” taken.",
  restoreLabel: "Restore {name}",
  restored: "Restored the snapshot “{name}”.",
  failed: "Snapshot: {error}",
  noImage: "Open an image to take a snapshot.",
  prefsSaved: "History options: {depth} steps, {memory} MB.",
});

/** The session's internals the verbs need. */
export interface PresetCtx {
  host: BundleHost;
  state: ImageSessionState;
  emit(): void;
  setStatus(s: string): void;
  engine(): ImageEngine | null;
  ensureEngine(): Promise<ImageEngine | null>;
  api(): ImageSession;
  /** Make RGBA the defined pattern (Edit ▸ Define Pattern's slot). */
  usePattern(width: number, height: number, rgba: Uint8Array): boolean;
  /** The defined pattern's pixels, or null. */
  definedPattern(): { width: number; height: number; rgba: Uint8Array } | null;
  importAbr(name: string, bytes: Uint8Array): Promise<boolean>;
  exportAbr(eng: ImageEngine, list: readonly UserBrushPreset[]): Uint8Array;
  /** Re-read the engine's history into state. */
  refresh(): void;
  /** Re-composite after a history move (as an undo does). */
  afterHistoryMove(): Promise<void>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The file each kind imports and exports. */
export const PRESET_FILE: Record<
  PresetKind,
  { accept: string[]; ext: string; mime: string }
> = {
  brushes: {
    accept: [".abr", ".json"],
    ext: "abr",
    mime: "application/octet-stream",
  },
  tools: { accept: [".json"], ext: "json", mime: "application/json" },
  adjustments: { accept: [".json"], ext: "json", mime: "application/json" },
  gradients: { accept: [".grd"], ext: "grd", mime: "application/octet-stream" },
  patterns: { accept: [".pat"], ext: "pat", mime: "application/octet-stream" },
  styles: { accept: [".asl"], ext: "asl", mime: "application/octet-stream" },
};

type AnyPreset = PresetEntry;

/** The Preset Manager's verbs on the session. */
export interface PresetOps {
  /** Resolves once the stored libraries are loaded over the defaults. */
  presetsLoaded(): Promise<void>;
  openPresetManager(tab?: PresetKind): boolean;
  setPresetManagerTab(tab: PresetKind): void;
  renamePresetOf(kind: PresetKind, id: string, name: string): boolean;
  /** A built-in preset is not deleted. */
  deletePresetOf(kind: PresetKind, id: string): boolean;
  movePresetOf(kind: PresetKind, from: number, to: number): boolean;
  applyPresetOf(kind: PresetKind, id: string): Promise<boolean>;
  /** Save the current settings of `kind` (the brush tip from the
   *  selection, the tool's options, the adjustment chain, foreground to
   *  background, the defined pattern, the active layer's style). */
  savePresetOf(kind: PresetKind, name?: string): Promise<boolean>;
  importPresetBytes(
    kind: PresetKind,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<boolean>;
  importPresetsOf(kind: PresetKind): Promise<boolean>;
  exportPresetBytes(
    kind: PresetKind,
  ): Promise<{ bytes: Uint8Array; name: string; mimeType: string } | null>;
  exportPresetsOf(kind: PresetKind): Promise<boolean>;
  brushPresetsJson(): string;
}

/** History snapshots and History Options on the session. */
export interface HistoryOps {
  applyHistoryPrefs(eng: ImageEngine): void;
  afterLayersRead(): void;
  resetAutoSnapshot(): void;
  /** Name the current state (not an undo step). */
  takeSnapshot(name?: string): boolean;
  /** Return to a snapshot as ONE undo step. */
  restoreSnapshot(id: number): Promise<boolean>;
  renameSnapshot(id: number, name: string): boolean;
  deleteSnapshot(id: number): boolean;
  openHistoryOptions(): boolean;
  setHistoryPrefs(patch: Partial<HistoryPrefs>): HistoryPrefs;
}

export function createPresetOps(ctx: PresetCtx): PresetOps {
  const { host, state } = ctx;

  const listOf = (kind: PresetKind): readonly AnyPreset[] => {
    switch (kind) {
      case "brushes":
        return state.brushPresets;
      case "tools":
        return state.toolPresets;
      case "adjustments":
        return state.adjustmentPresets;
      case "gradients":
        return state.gradientPresets;
      case "patterns":
        return state.patternPresets;
      case "styles":
        return state.stylePresets;
    }
  };

  const lists = (): Required<StoredPresets> => ({
    brushes: [...state.brushPresets],
    tools: [...state.toolPresets],
    adjustments: [...state.adjustmentPresets],
    gradients: [...state.gradientPresets],
    patterns: [...state.patternPresets],
    styles: [...state.stylePresets],
  });

  /** Store `kind`; a library that stays session-only is said once. */
  const persist = (kind: PresetKind) => {
    void savePresets(host, kind, lists()).then((short) => {
      if (short)
        ctx.setStatus(
          t(short === "brushes" ? P.sessionOnlyBrushes : P.sessionOnlyPatterns),
        );
    });
  };

  const setList = (kind: PresetKind, list: readonly AnyPreset[]) => {
    if (list === listOf(kind)) return false;
    switch (kind) {
      case "brushes":
        state.brushPresets = list as readonly UserBrushPreset[];
        if (!list.some((p) => p.id === state.brushPresetActive))
          state.brushPresetActive = null;
        break;
      case "tools":
        state.toolPresets = list as readonly ToolPreset[];
        break;
      case "adjustments":
        state.adjustmentPresets = list as readonly AdjustmentPreset[];
        break;
      case "gradients":
        state.gradientPresets = list as readonly GradientPreset[];
        break;
      case "patterns":
        state.patternPresets = list as readonly PatternPreset[];
        break;
      case "styles":
        state.stylePresets = list as StylePreset[];
        break;
    }
    persist(kind);
    ctx.emit();
    return true;
  };

  /** Load every stored library over the defaults (at activation). */
  const loaded = loadPresets(host)
    .then((stored) => {
      if (stored.brushes) state.brushPresets = stored.brushes;
      if (stored.tools) state.toolPresets = stored.tools;
      if (stored.adjustments) state.adjustmentPresets = stored.adjustments;
      if (stored.gradients) state.gradientPresets = stored.gradients;
      if (stored.patterns) state.patternPresets = stored.patterns;
      if (stored.styles) state.stylePresets = stored.styles;
      ctx.emit();
    })
    .catch((err: unknown) =>
      host.log.warn(`image: presets did not load: ${errText(err)}`),
    );

  const stylePatterns = (style: LayerStyle) => {
    const refs: Array<{ name: string; id: string }> = [];
    const add = (p: { name: string; id: string } | undefined) => {
      if (p && (p.name || p.id)) refs.push(p);
    };
    add(style.patternOverlay?.fill.pattern);
    for (const s of style.strokes)
      if (s.fill.kind === "pattern") add(s.fill.pattern);
    add(style.bevel?.texture?.fill.pattern);
    return refs;
  };

  /** The library patterns a style draws (by Photoshop id, else name). */
  const patternsFor = (style: LayerStyle) =>
    stylePatterns(style)
      .map(
        (r) =>
          state.patternPresets.find((p) => r.id && p.psId === r.id) ??
          state.patternPresets.find((p) => p.name === r.name),
      )
      .filter((p): p is PatternPreset => p !== undefined);

  const pick = async (kind: PresetKind) => {
    if (!host.supports("shell.pickFile@1")) {
      ctx.setStatus(t(P.noPicker));
      return null;
    }
    const picked = await host.shell.pickFile({
      accept: PRESET_FILE[kind].accept,
    });
    if (!picked[0]) ctx.setStatus(t(P.chosenNothing));
    return picked[0] ?? null;
  };

  const ops: PresetOps = {
    presetsLoaded: () => loaded,

    openPresetManager(tab: PresetKind = "brushes") {
      state.dialog = { kind: "presetManager", tab };
      ctx.emit();
      return true;
    },

    setPresetManagerTab(tab: PresetKind) {
      if (state.dialog?.kind !== "presetManager") return;
      state.dialog = { kind: "presetManager", tab };
      ctx.emit();
    },

    renamePresetOf(kind: PresetKind, id: string, name: string) {
      return setList(kind, renameEntry(listOf(kind), id, name));
    },

    deletePresetOf(kind: PresetKind, id: string) {
      return setList(kind, deleteEntry(listOf(kind), id));
    },

    movePresetOf(kind: PresetKind, from: number, to: number) {
      return setList(kind, moveEntry(listOf(kind), from, to));
    },

    async applyPresetOf(kind: PresetKind, id: string): Promise<boolean> {
      const api = ctx.api();
      const p = listOf(kind).find((x) => x.id === id);
      if (!p) {
        ctx.setStatus(t(P.noSuch));
        return false;
      }
      switch (kind) {
        case "brushes":
          return api.applyUserPreset(id);
        case "tools": {
          const tp = p as ToolPreset;
          api.setBrushParams({ ...tp.brush });
          if (tp.dynamics) state.dynamics = cloneDynamics(tp.dynamics);
          if (tp.paintTools) state.paintTools = structuredClone(tp.paintTools);
          break;
        }
        case "adjustments":
          api.setParams(structuredClone((p as AdjustmentPreset).params));
          break;
        case "gradients": {
          const ends = gradientEnds((p as GradientPreset).gradient);
          api.setForeground(ends.first);
          api.setBackground(ends.last);
          ctx.setStatus(t(P.gradientEnds, { name: p.name }));
          return true;
        }
        case "patterns": {
          const pp = p as PatternPreset;
          if (!ctx.usePattern(pp.width, pp.height, pp.rgba)) return false;
          ctx.setStatus(
            t(P.patternUsed, { name: pp.name, w: pp.width, h: pp.height }),
          );
          return true;
        }
        case "styles": {
          if (!state.source) {
            ctx.setStatus(t(P.noLayerForStyle));
            return false;
          }
          const sp = p as StylePreset;
          const eng = ctx.engine();
          for (const pat of patternsFor(sp.style)) {
            try {
              eng?.defineStylePattern(
                pat.psId || pat.name,
                pat.rgba,
                pat.width,
                pat.height,
              );
            } catch (err) {
              host.log.debug("style pattern define failed", err);
            }
          }
          return api.setLayerStyle(state.layers.active, cloneStyle(sp.style));
        }
      }
      ctx.setStatus(t(P.applied, { name: p.name }));
      return true;
    },

    /** Save the current settings of `kind` as a new preset. */
    async savePresetOf(kind: PresetKind, name?: string): Promise<boolean> {
      const api = ctx.api();
      const list = listOf(kind);
      const presetName = name?.trim() || untitledPreset(list.length + 1);
      switch (kind) {
        case "brushes":
          return api.defineBrushPreset(name);
        case "styles": {
          if (!api.saveStylePreset(presetName)) {
            ctx.setStatus(t(P.noStyle));
            return false;
          }
          persist("styles");
          break;
        }
        case "tools": {
          const { color: _c, pressureTarget: _p, ...brush } = state.brush;
          setList(
            kind,
            appendEntries(state.toolPresets, "tool", [
              {
                name: presetName,
                brush,
                dynamics: cloneDynamics(state.dynamics),
                paintTools: structuredClone(state.paintTools),
              },
            ]),
          );
          break;
        }
        case "adjustments":
          setList(
            kind,
            appendEntries(state.adjustmentPresets, "adjust", [
              { name: presetName, params: structuredClone(state.params) },
            ]),
          );
          break;
        case "gradients": {
          const [fg, bg] = [state.colors.fg, state.colors.bg];
          const rgb = (c: readonly number[]) =>
            [0, 1, 2].map((i) => Math.round((c[i] ?? 0) * 255)) as [
              number,
              number,
              number,
            ];
          setList(
            kind,
            appendEntries(state.gradientPresets, "gradient", [
              {
                name: presetName,
                gradient: {
                  name: presetName,
                  smoothness: 100,
                  stops: [
                    { at: 0, rgb: rgb(fg), midpoint: 0.5 },
                    { at: 1, rgb: rgb(bg), midpoint: 0.5 },
                  ],
                  opacityStops: [
                    { at: 0, opacity: fg[3] ?? 1, midpoint: 0.5 },
                    { at: 1, opacity: bg[3] ?? 1, midpoint: 0.5 },
                  ],
                },
              },
            ]),
          );
          break;
        }
        case "patterns": {
          const px = ctx.definedPattern();
          if (!px) {
            ctx.setStatus(t(P.noPattern));
            return false;
          }
          setList(
            kind,
            appendEntries(state.patternPresets, "pattern", [
              { name: presetName, psId: "", ...px },
            ]),
          );
          break;
        }
      }
      ctx.setStatus(t(P.saved, { name: presetName }));
      return true;
    },

    /** Import a file's presets into `kind`'s library. */
    async importPresetBytes(
      kind: PresetKind,
      fileName: string,
      bytes: Uint8Array,
    ): Promise<boolean> {
      const lower = fileName.toLowerCase();
      if (kind === "brushes") {
        if (!lower.endsWith(".json")) return ctx.importAbr(fileName, bytes);
        try {
          const before = state.brushPresets;
          let list: readonly UserBrushPreset[] = before;
          for (const p of deserializePresets(new TextDecoder().decode(bytes))) {
            const id = freshId("brush", list);
            list = [
              ...list,
              {
                ...p,
                id,
                source: "imported",
                dynamics: p.dynamics.bitmap
                  ? { ...p.dynamics, bitmap: { ...p.dynamics.bitmap, id } }
                  : p.dynamics,
              },
            ];
          }
          setList(kind, list);
          ctx.setStatus(
            t(P.imported, {
              count: list.length - before.length,
              name: fileName,
            }),
          );
          return true;
        } catch (err) {
          ctx.setStatus(
            t(P.importFailed, { name: fileName, error: errText(err) }),
          );
          return false;
        }
      }
      if (kind === "tools" || kind === "adjustments") {
        try {
          const entries = parseLibrary(new TextDecoder().decode(bytes), kind);
          const prefix = kind === "tools" ? "tool" : "adjust";
          setList(
            kind,
            appendEntries(listOf(kind), prefix, entries as never[]),
          );
          ctx.setStatus(
            t(P.imported, { count: entries.length, name: fileName }),
          );
          return true;
        } catch (err) {
          ctx.setStatus(
            t(P.importFailed, { name: fileName, error: errText(err) }),
          );
          return false;
        }
      }
      const eng = await ctx.ensureEngine();
      if (!eng) {
        ctx.setStatus(t(P.noEngine));
        return false;
      }
      try {
        let count = 0;
        let skipped: string[] = [];
        const addPatterns = (metas: PatternPresetMeta[], rgba: Uint8Array) => {
          let at = 0;
          const fresh: Array<Omit<PatternPreset, "id">> = [];
          for (const m of metas) {
            const n = m.width * m.height * 4;
            const px = rgba.slice(at, at + n);
            at += n;
            // A pattern already in the library (same Photoshop id) is
            // not added twice; a style refers to it by that id.
            if (m.id && state.patternPresets.some((p) => p.psId === m.id))
              continue;
            fresh.push({
              name: m.display || m.name,
              psId: m.id,
              width: m.width,
              height: m.height,
              rgba: px,
            });
          }
          if (fresh.length)
            setList(
              "patterns",
              appendEntries(state.patternPresets, "pattern", fresh),
            );
          return fresh.length;
        };
        if (kind === "gradients") {
          const f = eng.presetsReadGrd(bytes);
          setList(
            kind,
            appendEntries(
              state.gradientPresets,
              "gradient",
              f.gradients.map((g) => ({
                name: g.display || g.gradient.name,
                gradient: g.gradient,
              })),
            ),
          );
          count = f.gradients.length;
          if (f.skipped) skipped = [`${f.skipped} noise`];
        } else if (kind === "patterns") {
          const f = eng.presetsReadPat(bytes);
          count = addPatterns(f.patterns, f.rgba);
          skipped = f.skipped;
        } else {
          const f = eng.presetsReadAsl(bytes);
          addPatterns(f.patterns, f.rgba);
          setList(
            kind,
            appendEntries(
              state.stylePresets.map((s, i) => ({
                ...s,
                id: s.id ?? `style-${i + 1}`,
              })),
              "style",
              f.styles.map((s) => ({
                name: s.display || s.name,
                psId: s.id,
                style: s.style,
              })),
            ) as StylePreset[],
          );
          count = f.styles.length;
          skipped = f.skipped;
        }
        ctx.setStatus(
          skipped.length
            ? t(P.importedSkipped, {
                count,
                name: fileName,
                skipped: skipped.length,
                why: skipped.slice(0, 2).join("; "),
              })
            : t(P.imported, { count, name: fileName }),
        );
        return true;
      } catch (err) {
        ctx.setStatus(
          t(P.importFailed, { name: fileName, error: errText(err) }),
        );
        return false;
      }
    },

    async importPresetsOf(kind: PresetKind): Promise<boolean> {
      const file = await pick(kind);
      if (!file) return false;
      return ops.importPresetBytes(kind, file.name, file.bytes);
    },

    /** `kind`'s library as its file: bytes, a name and a type. */
    async exportPresetBytes(
      kind: PresetKind,
    ): Promise<{ bytes: Uint8Array; name: string; mimeType: string } | null> {
      const list = listOf(kind);
      if (list.length === 0) {
        ctx.setStatus(t(P.nothingToExport));
        return null;
      }
      const { ext, mime } = PRESET_FILE[kind];
      const name = `${kind}.${ext}`;
      if (kind === "tools" || kind === "adjustments") {
        const text = serializeLibrary(
          kind,
          list as readonly (ToolPreset | AdjustmentPreset)[],
        );
        return { bytes: new TextEncoder().encode(text), name, mimeType: mime };
      }
      const eng = await ctx.ensureEngine();
      if (!eng) {
        ctx.setStatus(t(P.noEngine));
        return null;
      }
      try {
        let bytes: Uint8Array;
        if (kind === "brushes") bytes = ctx.exportAbr(eng, state.brushPresets);
        else if (kind === "gradients")
          bytes = eng.presetsWriteGrd(
            state.gradientPresets.map((g) => ({ ...g.gradient, name: g.name })),
          );
        else if (kind === "patterns") {
          const ps = state.patternPresets;
          bytes = eng.presetsWritePat(...patternPayload(ps));
        } else {
          const used = new Map<string, PatternPreset>();
          for (const s of state.stylePresets)
            for (const p of patternsFor(s.style)) used.set(p.id, p);
          bytes = eng.presetsWriteAsl(
            state.stylePresets.map((s) => ({
              name: s.name,
              id: s.psId ?? "",
              style: s.style,
            })),
            ...patternPayload([...used.values()]),
          );
        }
        return { bytes, name, mimeType: mime };
      } catch (err) {
        ctx.setStatus(t(P.exportFailed, { error: errText(err) }));
        return null;
      }
    },

    async exportPresetsOf(kind: PresetKind): Promise<boolean> {
      if (!host.supports("shell.saveFile@1")) {
        ctx.setStatus(t(P.noSaver));
        return false;
      }
      const out = await ops.exportPresetBytes(kind);
      if (!out) return false;
      const ok = await host.shell.saveFile({
        suggestedName: out.name,
        bytes: out.bytes,
        mimeType: out.mimeType,
      });
      ctx.setStatus(
        ok
          ? t(P.exported, { count: listOf(kind).length, name: out.name })
          : t(P.exportDeclined),
      );
      return ok;
    },

    /** The brush library as the own JSON (kept for the brush panel's
     *  JSON export, which carries what `.abr` cannot). */
    brushPresetsJson: () => serializePresets(state.brushPresets),
  };
  return ops;
}

/** Patterns as the engine's write doors take them. */
function patternPayload(
  ps: readonly PatternPreset[],
): [PatternPresetMeta[], Uint8Array] {
  const total = ps.reduce((n, p) => n + p.rgba.length, 0);
  const rgba = new Uint8Array(total);
  let at = 0;
  const meta: PatternPresetMeta[] = [];
  for (const p of ps) {
    rgba.set(p.rgba, at);
    at += p.rgba.length;
    meta.push({
      name: p.name,
      id: p.psId || p.id,
      width: p.width,
      height: p.height,
    });
  }
  return [meta, rgba];
}

// ── history: snapshots and options ───────────────────────────────────

export function createHistoryOps(ctx: PresetCtx): HistoryOps {
  const { host, state } = ctx;
  state.historyPrefs = loadHistoryPrefs(host) ?? clampHistoryPrefs({});
  /** Whether a preference was ever stored (the engine's own bounds apply
   *  until then). */
  let prefsStored = loadHistoryPrefs(host) !== null;
  /** The source handle the automatic snapshot was taken for. */
  let autoSnapshotFor: number | null = null;

  const ops: HistoryOps = {
    /** Hand the stored bounds to the engine (at boot). */
    applyHistoryPrefs(eng: ImageEngine) {
      if (!prefsStored) return;
      try {
        eng.layersSetHistoryBudget(
          state.historyPrefs.depth,
          state.historyPrefs.memoryMb * 1024 * 1024,
        );
      } catch (err) {
        host.log.debug("history budget failed", err);
      }
    },

    /** Called after every layer readout: take the automatic snapshot
     *  once per opened image. */
    afterLayersRead() {
      const eng = ctx.engine();
      const src = state.source;
      if (!eng || !src || !state.history) return;
      if (!state.historyPrefs.autoSnapshot || autoSnapshotFor === src.handle)
        return;
      autoSnapshotFor = src.handle;
      if (state.history.snapshots.length > 0) return;
      try {
        eng.snapshotTake(t(H.opened));
        state.history = eng.layersHistory();
      } catch (err) {
        host.log.debug("automatic snapshot failed", err);
      }
    },

    /** A new stack replaced the old one on the same handle (a layered
     *  PSD open, a reopened commit): it may take its own snapshot. */
    resetAutoSnapshot() {
      autoSnapshotFor = null;
    },

    takeSnapshot(name?: string): boolean {
      const eng = ctx.engine();
      if (!eng || !state.source || !state.history) {
        ctx.setStatus(t(H.noImage));
        return false;
      }
      const n = state.history.snapshots.length + 1;
      const label = name?.trim() || t(H.snapshotName, { n });
      try {
        eng.snapshotTake(label);
      } catch (err) {
        ctx.setStatus(t(H.failed, { error: errText(err) }));
        return false;
      }
      ctx.refresh();
      ctx.setStatus(t(H.taken, { name: label }));
      return true;
    },

    async restoreSnapshot(id: number): Promise<boolean> {
      const eng = ctx.engine();
      const snap = state.history?.snapshots.find((s) => s.id === id);
      if (!eng || !snap) {
        ctx.setStatus(t(H.noImage));
        return false;
      }
      try {
        await eng.snapshotRestore(id, t(H.restoreLabel, { name: snap.name }));
      } catch (err) {
        ctx.setStatus(t(H.failed, { error: errText(err) }));
        return false;
      }
      await ctx.afterHistoryMove();
      ctx.setStatus(t(H.restored, { name: snap.name }));
      return true;
    },

    renameSnapshot(id: number, name: string): boolean {
      const eng = ctx.engine();
      if (!eng) return false;
      try {
        eng.snapshotRename(id, name);
      } catch (err) {
        ctx.setStatus(t(H.failed, { error: errText(err) }));
        return false;
      }
      ctx.refresh();
      ctx.emit();
      return true;
    },

    deleteSnapshot(id: number): boolean {
      const eng = ctx.engine();
      if (!eng) return false;
      try {
        eng.snapshotDelete(id);
      } catch (err) {
        ctx.setStatus(t(H.failed, { error: errText(err) }));
        return false;
      }
      // A brush source that named it falls back to the opened state.
      if (state.paintTools.history.source === `snapshot:${id}`)
        state.paintTools = {
          ...state.paintTools,
          history: { source: "open" },
        };
      ctx.refresh();
      ctx.emit();
      return true;
    },

    openHistoryOptions(): boolean {
      state.dialog = { kind: "historyOptions" };
      ctx.emit();
      return true;
    },

    /** History Options: store the preference and apply it to the open
     *  stack (a tighter depth drops the oldest steps at once). */
    setHistoryPrefs(patch: Partial<HistoryPrefs>): HistoryPrefs {
      const next = clampHistoryPrefs({ ...state.historyPrefs, ...patch });
      state.historyPrefs = next;
      prefsStored = true;
      saveHistoryPrefs(host, next);
      const eng = ctx.engine();
      if (eng) {
        try {
          const set = eng.layersSetHistoryBudget(
            next.depth,
            next.memoryMb * 1024 * 1024,
          );
          state.historyPrefs = {
            ...next,
            depth: set.maxEntries,
            memoryMb: Math.round(set.maxBytes / (1024 * 1024)),
          };
        } catch (err) {
          host.log.debug("history budget failed", err);
        }
        ctx.refresh();
      }
      ctx.setStatus(
        t(H.prefsSaved, {
          depth: state.historyPrefs.depth,
          memory: state.historyPrefs.memoryMb,
        }),
      );
      return state.historyPrefs;
    },
  };
  return ops;
}
