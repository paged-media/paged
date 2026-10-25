/*
 * This file is part of paged (https://paged.media).
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

// RETOUCHING in the session (WP5.8): the Content-Aware Fill workspace, the
// Content-Aware Move tool's drop and transform, the Remove tool (with the
// pluggable `ml.inpaint` provider), the Clone Source panel's five sources
// and overlay, and the healing options (diffusion, spot type, sample).
//
// The session owns the state object and the frame; this module owns the
// retouching part of both, through the narrow `RetouchDeps` the session
// hands it. Every edit lands engine-side as ONE journaled undo step; the
// session then adopts the result exactly as it does an applied filter.
// None of these needs WebGPU: the search is CPU and the vote has a CPU
// twin, so a one-layer image retouches without a device.

import type { BundleHost } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import { latestWins } from "./coalesce";
import type { DecodedInfo, ImageEngine } from "./engine";
import { hostInpaintProvider, type InpaintProvider } from "./ml-inpaint";
import type {
  CafOutput,
  CafPreview,
  FillSettings,
  MoveMode,
  SampleMode,
  SpotType,
  StrokeSampling,
} from "./retouch-engine";

/** The Content-Aware Fill workspace (Edit ▸ Content-Aware Fill…). */
export interface CafWorkspace {
  sampling: "auto" | "rect" | "custom";
  /** Show the sampling area on the canvas. */
  showSampling: boolean;
  /** The overlay's opacity, 0–1. */
  overlayOpacity: number;
  fill: FillSettings;
  output: CafOutput;
  sampleAll: boolean;
  /** Compute the preview as settings change. */
  previewOn: boolean;
  preview: CafPreview | null;
  /** Why there is no preview, when there is none. */
  previewNote: string | null;
  /** Sampled pixels / all pixels, for the readout. */
  sampledFraction: number;
}

/** One of the Clone Source panel's five sources. */
export interface CloneSourceSlot {
  /** The anchor (Alt-click), image px; null until set. */
  anchor: [number, number] | null;
  /** A typed `target − source` offset, or null to fix it at the first dab. */
  offset: [number, number] | null;
  /** Width / height in percent (negative = flipped). */
  scaleW: number;
  scaleH: number;
  angle: number;
}

export interface CloneOverlayOptions {
  show: boolean;
  /** 0–100. */
  opacity: number;
  clipped: boolean;
  autoHide: boolean;
  invert: boolean;
}

export interface CloneSourceState {
  active: number;
  slots: CloneSourceSlot[];
  overlay: CloneOverlayOptions;
  sample: SampleMode;
  /** The offset an Aligned clone carries to its next stroke. */
  carried: [number, number] | null;
}

export interface HealOptions {
  /** 1–7 (Photoshop's default 5). */
  diffusion: number;
  spotType: SpotType;
  sample: SampleMode;
}

export interface MoveOptions {
  mode: MoveMode;
  /** 1–7. */
  structure: number;
  /** 0–10. */
  colour: number;
  transformOnDrop: boolean;
  sampleAll: boolean;
}

/** A Content-Aware Move waiting for its transform (transform on drop). */
export interface PendingMove {
  dx: number;
  dy: number;
  /** Percent. */
  scale: number;
  angle: number;
}

export interface RetouchState {
  caf: CafWorkspace | null;
  cloneSource: CloneSourceState;
  heal: HealOptions;
  move: MoveOptions;
  pendingMove: PendingMove | null;
  remove: { sampleAll: boolean };
  /** The `ml.inpaint` provider the Remove tool uses, or null (classical). */
  inpaintProvider: string | null;
}

export const CLONE_SOURCE_COUNT = 5;

export function emptySlot(): CloneSourceSlot {
  return { anchor: null, offset: null, scaleW: 100, scaleH: 100, angle: 0 };
}

export function initialRetouch(): RetouchState {
  return {
    caf: null,
    cloneSource: {
      active: 0,
      slots: Array.from({ length: CLONE_SOURCE_COUNT }, emptySlot),
      overlay: {
        show: true,
        opacity: 50,
        clipped: true,
        autoHide: true,
        invert: false,
      },
      sample: "current",
      carried: null,
    },
    heal: { diffusion: 5, spotType: "content-aware", sample: "current" },
    move: {
      mode: "move",
      structure: 4,
      colour: 0,
      transformOnDrop: true,
      sampleAll: false,
    },
    pendingMove: null,
    remove: { sampleAll: false },
    inpaintProvider: null,
  };
}

export const DEFAULT_CAF: Omit<
  CafWorkspace,
  "preview" | "previewNote" | "sampledFraction"
> = {
  sampling: "auto",
  showSampling: true,
  overlayOpacity: 0.5,
  fill: {
    colour: "default",
    rotation: "none",
    scale: false,
    mirror: false,
    seed: 1,
  },
  output: "current",
  sampleAll: false,
  previewOn: true,
};

const S = defineMessages("image.retouchStatus", {
  needsImage: "Open an image first.",
  needsSelection: "{what} needs a selection — select the area first.",
  failed: "{what} failed: {error}",
  done: "{what} applied — one undo step.",
  cafOpen:
    "Content-Aware Fill: the green area is sampled. Paint it with the " +
    "Sampling brush (Alt erases); OK fills the selection.",
  movePending:
    "Content-Aware Move: set the scale and angle, then press Enter or " +
    "Commit (Escape cancels).",
  moveCancelled: "Content-Aware Move cancelled — nothing changed.",
  removeEmpty: "The Remove stroke covers nothing on the image.",
  removedMl: "Removed with {provider} — one undo step.",
  cloneSourceSet:
    "Clone source {n} set at {x}, {y} — paint to copy from there.",
  previewFailed: "No preview: {error}",
});

const CAF = "Content-Aware Fill";
const MOVE = "Content-Aware Move";
const REMOVE = "Remove";

/** What the session lends this module. */
export interface RetouchDeps {
  host: BundleHost;
  state(): {
    source: {
      handle: number;
      width: number;
      height: number;
      elementId: string | null;
    } | null;
    selection: unknown;
    busy: boolean;
    status: string;
    dialog: { kind: string } | null;
    cloneSource: { x: number; y: number; aligned: boolean } | null;
    retouch: RetouchState;
  };
  setDialog(d: { kind: "contentAwareFill" } | null): void;
  engine(): ImageEngine | null;
  emit(): void;
  setStatus(s: string): void;
  /** Adopt an edit's result (swap / bump the source, recomposite). */
  adopt(out: DecodedInfo): Promise<boolean>;
  /** Show straight RGBA8 of the image's size in the frame (a preview). */
  showPixels(rgba: Uint8Array, width: number, height: number): Promise<boolean>;
  /** Put the committed composite back in the frame. */
  restoreFrame(): Promise<void>;
  discardStroke(): void;
  /** The image's current composite (straight RGBA8). */
  composite(): Promise<Uint8Array>;
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** The largest side a CAF preview is computed at. */
export const CAF_PREVIEW_SIDE = 512;

export function makeRetouch(d: RetouchDeps) {
  const st = () => d.state().retouch;
  /** The sampling area, one byte per image pixel (not in the state: it is
   *  image-sized). */
  let sampleMask: Uint8Array | null = null;
  let provider: InpaintProvider | null = hostInpaintProvider(d.host);
  st().inpaintProvider = provider?.id ?? null;

  const need = (what: string, selection: boolean): boolean => {
    const s = d.state();
    if (!s.source || !d.engine()) {
      d.setStatus(t(S.needsImage));
      return false;
    }
    if (selection && !s.selection) {
      d.setStatus(t(S.needsSelection, { what }));
      return false;
    }
    return true;
  };

  /** Run one engine edit and adopt it, the session's applied-edit path. */
  const edit = async (
    what: string,
    run: (handle: number) => Promise<DecodedInfo>,
  ): Promise<boolean> => {
    const s = d.state();
    const src = s.source!;
    s.busy = true;
    d.emit();
    let out: DecodedInfo;
    try {
      out = await run(src.handle);
    } catch (err) {
      s.busy = false;
      d.setStatus(t(S.failed, { what, error: errText(err) }));
      return false;
    }
    s.busy = false;
    const ok = await d.adopt(out);
    if (ok) d.setStatus(t(S.done, { what }));
    return ok;
  };

  // ── Content-Aware Fill workspace ────────────────────────────────────

  const caf = () => st().caf;

  const refreshMask = () => {
    const w = caf();
    const s = d.state();
    const eng = d.engine();
    if (!w || !s.source || !eng) return;
    if (w.sampling !== "custom" || !sampleMask) {
      try {
        sampleMask = eng.cafSamplingArea(
          s.source.handle,
          w.sampling === "rect" ? "rect" : "auto",
        );
      } catch (err) {
        sampleMask = null;
        w.previewNote = errText(err);
      }
    }
    let n = 0;
    for (const b of sampleMask ?? []) if (b) n++;
    w.sampledFraction = sampleMask ? n / sampleMask.length : 0;
  };

  const overlayNow = async (): Promise<boolean> => {
    const w = caf();
    const s = d.state();
    const eng = d.engine();
    if (!w || !s.source || !eng) return false;
    if (!w.showSampling || !sampleMask) {
      await d.restoreFrame();
      return true;
    }
    try {
      const rgba = eng.cafOverlay(
        s.source.handle,
        sampleMask,
        w.overlayOpacity,
      );
      return d.showPixels(rgba, s.source.width, s.source.height);
    } catch (err) {
      d.state().retouch.caf!.previewNote = errText(err);
      return false;
    }
  };
  const overlay = latestWins(overlayNow);

  const previewNow = async (): Promise<boolean> => {
    const w = caf();
    const s = d.state();
    const eng = d.engine();
    if (!w || !s.source || !eng || !w.previewOn) return false;
    try {
      w.preview = eng.cafPreview(
        s.source.handle,
        w.sampling === "custom" ? sampleMask : null,
        w.fill,
        CAF_PREVIEW_SIDE,
        w.sampleAll,
      );
      w.previewNote = null;
    } catch (err) {
      w.preview = null;
      w.previewNote = t(S.previewFailed, { error: errText(err) });
    }
    st().caf = { ...w };
    d.emit();
    return true;
  };
  const preview = latestWins(previewNow);

  const closeCaf = async () => {
    st().caf = null;
    sampleMask = null;
    if (d.state().dialog?.kind === "contentAwareFill") d.setDialog(null);
    await d.restoreFrame();
    d.emit();
  };

  // ── clone source helpers ────────────────────────────────────────────

  const activeSlot = () => st().cloneSource.slots[st().cloneSource.active];

  const transformOf = (slot: CloneSourceSlot) => ({
    scaleX: (slot.scaleW || 100) / 100,
    scaleY: (slot.scaleH || 100) / 100,
    angleDeg: slot.angle,
  });

  const showOverlayNow = async (
    point: [number, number],
    radius: number,
  ): Promise<boolean> => {
    const s = d.state();
    const eng = d.engine();
    const cs = st().cloneSource;
    const slot = activeSlot();
    if (!s.source || !eng || !cs.overlay.show || !slot.anchor) return false;
    try {
      const rgba = await eng.cloneOverlay(s.source.handle, {
        cursor: point,
        anchor: slot.anchor,
        offset: slot.offset
          ? [-slot.offset[0], -slot.offset[1]]
          : (cs.carried ?? null),
        ...transformOf(slot),
        opacity: cs.overlay.opacity / 100,
        invert: cs.overlay.invert,
        clipRadius: cs.overlay.clipped ? Math.max(1, radius) : 0,
        mode: cs.sample,
      });
      return d.showPixels(rgba, s.source.width, s.source.height);
    } catch {
      return false;
    }
  };
  let overlayArgs: { point: [number, number]; radius: number } | null = null;
  let overlayShown = false;
  const showOverlay = latestWins(async () => {
    if (!overlayArgs) return false;
    const ok = await showOverlayNow(overlayArgs.point, overlayArgs.radius);
    overlayShown = overlayShown || ok;
    return ok;
  });

  // ── Content-Aware Move ───────────────────────────────────────────────

  const runMove = async (p: PendingMove): Promise<boolean> => {
    const m = st().move;
    st().pendingMove = null;
    return edit(MOVE, (h) =>
      d.engine()!.contentAwareMove(h, {
        dx: p.dx,
        dy: p.dy,
        mode: m.mode,
        structure: m.structure,
        colour: m.colour,
        scale: p.scale / 100,
        angleDeg: p.angle,
        sampleAll: m.sampleAll,
      }),
    );
  };

  return {
    // ── CAF workspace ──
    /** Edit ▸ Content-Aware Fill…: open the workspace over the selection —
     *  the sampling area on the canvas, the preview in the panel. */
    async openContentAwareFill(): Promise<boolean> {
      if (!need(CAF, true)) return false;
      d.discardStroke();
      st().caf = {
        ...DEFAULT_CAF,
        fill: { ...DEFAULT_CAF.fill },
        preview: null,
        previewNote: null,
        sampledFraction: 0,
      };
      sampleMask = null;
      d.setDialog({ kind: "contentAwareFill" });
      refreshMask();
      d.setStatus(t(S.cafOpen));
      await overlay();
      await preview();
      return true;
    },

    /** Change the workspace's settings; overlay and preview follow. */
    async setContentAwareFill(
      patch: Partial<Omit<CafWorkspace, "fill" | "preview" | "previewNote">> & {
        fill?: Partial<FillSettings>;
      },
    ): Promise<void> {
      const w = caf();
      if (!w) return;
      const next: CafWorkspace = {
        ...w,
        ...patch,
        fill: { ...w.fill, ...patch.fill },
      };
      const samplingChanged = next.sampling !== w.sampling;
      st().caf = next;
      if (samplingChanged && next.sampling !== "custom") sampleMask = null;
      refreshMask();
      d.emit();
      await overlay();
      if (next.previewOn) await preview();
    },

    /** The Sampling brush: add (or, with `erase`, remove) a disc of
     *  `radius` image px at `point`. The area becomes Custom. */
    paintCafSampling(point: [number, number], radius: number, erase: boolean) {
      const w = caf();
      const s = d.state();
      if (!w || !s.source) return false;
      refreshMask();
      if (!sampleMask) return false;
      w.sampling = "custom";
      const { width, height } = s.source;
      const r = Math.max(1, radius);
      const [cx, cy] = point;
      for (
        let y = Math.max(0, Math.floor(cy - r));
        y <= Math.min(height - 1, Math.ceil(cy + r));
        y++
      ) {
        for (
          let x = Math.max(0, Math.floor(cx - r));
          x <= Math.min(width - 1, Math.ceil(cx + r));
          x++
        ) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r)
            sampleMask[y * width + x] = erase ? 0 : 255;
        }
      }
      st().caf = { ...w };
      refreshMask();
      d.emit();
      void overlay();
      return true;
    },

    /** The Sampling brush released: the preview follows the new area. */
    async endCafPaint(): Promise<void> {
      if (caf()?.previewOn) await preview();
    },

    /** The sampling area as it stands (for tests and the readout). */
    cafSamplingMask(): Uint8Array | null {
      return sampleMask;
    },

    /** OK: fill the selection with the workspace's settings — one step. */
    async commitContentAwareFill(): Promise<boolean> {
      const w = caf();
      if (!w || !need(CAF, true)) return false;
      const sample = w.sampling === "custom" ? sampleMask : null;
      const ok = await edit(CAF, (h) =>
        d
          .engine()!
          .contentAwareFillEx(h, sample, w.fill, w.output, w.sampleAll),
      );
      if (ok) {
        st().caf = null;
        sampleMask = null;
        if (d.state().dialog?.kind === "contentAwareFill") d.setDialog(null);
        d.emit();
      }
      return ok;
    },

    /** Cancel: close the workspace; the image is as it was. */
    async cancelContentAwareFill(): Promise<void> {
      await closeCaf();
    },

    // ── Content-Aware Move ──
    setMoveOptions(patch: Partial<MoveOptions>) {
      const m = { ...st().move, ...patch };
      m.structure = Math.min(7, Math.max(1, Math.round(m.structure)));
      m.colour = Math.min(10, Math.max(0, Math.round(m.colour)));
      st().move = m;
      d.emit();
    },

    /** The tool's drop: commit, or hold for the transform on drop. */
    async dropContentAwareMove(dx: number, dy: number): Promise<boolean> {
      if (!need(MOVE, true)) return false;
      if (Math.round(dx) === 0 && Math.round(dy) === 0) return false;
      if (st().move.transformOnDrop) {
        st().pendingMove = { dx, dy, scale: 100, angle: 0 };
        d.setStatus(t(S.movePending));
        return true;
      }
      return runMove({ dx, dy, scale: 100, angle: 0 });
    },

    setMoveTransform(patch: Partial<PendingMove>) {
      const p = st().pendingMove;
      if (!p) return;
      st().pendingMove = { ...p, ...patch };
      d.emit();
    },

    async commitContentAwareMove(): Promise<boolean> {
      const p = st().pendingMove;
      if (!p || !need(MOVE, true)) return false;
      return runMove(p);
    },

    cancelContentAwareMove() {
      if (!st().pendingMove) return;
      st().pendingMove = null;
      d.setStatus(t(S.moveCancelled));
    },

    // ── Remove ──
    setRemoveOptions(patch: Partial<RetouchState["remove"]>) {
      st().remove = { ...st().remove, ...patch };
      d.emit();
    },

    /** Replace the provider the Remove tool asks first (null = classical
     *  PatchMatch only). */
    setInpaintProvider(p: InpaintProvider | null) {
      provider = p;
      st().inpaintProvider = p?.id ?? null;
      d.emit();
    },

    /** REMOVE what the stroke covers: the `ml.inpaint` provider when one is
     *  installed and answers, else the classical exemplar fill. */
    async removeStroke(points: number[], size: number): Promise<boolean> {
      if (!need(REMOVE, false)) return false;
      const s = d.state();
      const eng = d.engine()!;
      const src = s.source!;
      if (points.length < 2) return false;
      if (provider) {
        try {
          const mask = eng.removeHole(src.handle, points, size);
          if (mask.some((b) => b !== 0)) {
            const rgba = await provider.inpaint({
              rgba: await d.composite(),
              width: src.width,
              height: src.height,
              mask,
            });
            if (rgba) {
              const ok = await edit(REMOVE, (h) =>
                eng.removeWithPixels(h, rgba, points, size),
              );
              if (ok) d.setStatus(t(S.removedMl, { provider: provider.id }));
              return ok;
            }
          }
        } catch (err) {
          // A provider that fails is not the end of the edit: the
          // classical fill below still runs.
          d.host.log.debug("ml.inpaint provider failed", err);
        }
      }
      return edit(REMOVE, (h) =>
        eng.removeStroke(h, points, size, st().remove.sampleAll, 1),
      );
    },

    // ── Clone Source panel ──
    selectCloneSource(index: number) {
      const cs = st().cloneSource;
      if (index < 0 || index >= CLONE_SOURCE_COUNT) return;
      st().cloneSource = { ...cs, active: index, carried: null };
      d.emit();
    },

    setCloneSourceSlot(index: number, patch: Partial<CloneSourceSlot>) {
      const cs = st().cloneSource;
      if (index < 0 || index >= CLONE_SOURCE_COUNT) return;
      const slots = cs.slots.slice();
      slots[index] = { ...slots[index], ...patch };
      st().cloneSource = { ...cs, slots, carried: null };
      d.emit();
    },

    resetCloneTransform(index: number) {
      const cs = st().cloneSource;
      const slots = cs.slots.slice();
      slots[index] = {
        ...slots[index],
        offset: null,
        scaleW: 100,
        scaleH: 100,
        angle: 0,
      };
      st().cloneSource = { ...cs, slots };
      d.emit();
    },

    setCloneOverlay(patch: Partial<CloneOverlayOptions>) {
      const cs = st().cloneSource;
      st().cloneSource = { ...cs, overlay: { ...cs.overlay, ...patch } };
      d.emit();
    },

    setCloneSample(sample: SampleMode) {
      st().cloneSource = { ...st().cloneSource, sample };
      d.emit();
    },

    setHealOptions(patch: Partial<HealOptions>) {
      const h = { ...st().heal, ...patch };
      h.diffusion = Math.min(7, Math.max(1, Math.round(h.diffusion)));
      st().heal = h;
      d.emit();
    },

    /** Called when the anchor is set (Alt-click): it belongs to the active
     *  source, and a new anchor drops the carried offset. */
    onAnchor(x: number, y: number) {
      const cs = st().cloneSource;
      const slots = cs.slots.slice();
      slots[cs.active] = { ...slots[cs.active], anchor: [x, y] };
      st().cloneSource = { ...cs, slots, carried: null };
      return t(S.cloneSourceSet, {
        n: cs.active + 1,
        x: Math.round(x),
        y: Math.round(y),
      });
    },

    /** What a sampling stroke of `tool` reads (`brush_stroke_set_sampling`),
     *  or null for any other tool. */
    strokeSampling(tool: string, aligned: boolean): StrokeSampling | null {
      if (tool !== "clone" && tool !== "heal" && tool !== "spot-heal")
        return null;
      const cs = st().cloneSource;
      const h = st().heal;
      if (tool === "spot-heal") {
        return {
          mode: h.sample,
          scaleX: 1,
          scaleY: 1,
          angleDeg: 0,
          offset: null,
          diffusion: h.diffusion,
          spot: h.spotType,
        };
      }
      const slot = activeSlot();
      // A typed offset is target − source; the engine takes source − target.
      const offset: [number, number] | null = slot.offset
        ? [-slot.offset[0], -slot.offset[1]]
        : aligned
          ? cs.carried
          : null;
      return {
        mode: tool === "heal" ? h.sample : cs.sample,
        ...transformOf(slot),
        offset,
        diffusion: tool === "heal" ? h.diffusion : 0,
        spot: "content-aware",
      };
    },

    /** After a clone / heal stroke: an Aligned source carries its offset. */
    afterStroke(offset: [number, number] | null) {
      if (offset) st().cloneSource = { ...st().cloneSource, carried: offset };
    },

    /** The overlay under the cursor (clone / heal hover); null hides it. */
    async cloneOverlayAt(
      point: [number, number] | null,
      radius: number,
    ): Promise<boolean> {
      if (!point) {
        overlayArgs = null;
        if (overlayShown) {
          overlayShown = false;
          await d.restoreFrame();
        }
        return false;
      }
      overlayArgs = { point, radius };
      return showOverlay();
    },
  };
}

export type RetouchApi = ReturnType<typeof makeRetouch>;
