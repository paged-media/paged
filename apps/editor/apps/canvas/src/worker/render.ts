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

// Worker-side render loop for the IDML canvas.
//
// Owns the OffscreenCanvas, the camera SAB read side, the per-page
// tile cache, and the setTimeout-driven render loop (workers have no
// requestAnimationFrame; spec §3.1 accepts this).
//
// The CPU path: every tile is a 256-px `vello_cpu` snapshot
// (via `renderTilePng`). Composition is `ctx.drawImage` over the
// OffscreenCanvasRenderingContext2D. Per spec AC-V-7 no rendering
// happens on the main thread; the main thread only writes the camera
// SAB and posts attach/resize messages.
//
// Sub-phases B/C/D layer in WebGPU + Vello underneath the same render
// loop — see /Users/drietsch/.claude/plans/...canvas... for the full
// plan.

import { CameraBuffer, type Camera } from "@paged-media/client";
import { layoutPages, type PageRect } from "../ui/layout";
import type { PageId } from "@paged-media/client";
import { workerJournal } from "./journal";

/**
 * Wasm-side bindings the renderer needs. Subset of the
 * `CanvasWorker` wasm-bindgen surface from `crates/paged-canvas-wasm`.
 * Declared as an interface so this module doesn't depend on the
 * generated wasm types at import time (the worker imports them
 * separately).
 */
export interface RendererWasm {
  pageCount(): number;
  /** `[id, widthPt, heightPt, xPt?, yPt?]` — the last two (v77, engine
   *  ADR 1011) are the page's top-left on the canvas. */
  pageInfo(
    index: number,
  ): [string, number, number, number?, number?] | undefined;
  renderTilePng(pageId: string, targetWidthPx: number): Uint8Array | undefined;
  /**
   * When set, the renderer uses Vello via the worker's WebGPU
   * surface for the hot path. Returns true on a successful present;
   * false means the wasm side detected a fault and the renderer
   * should fall back (snapshot blit) for this frame.
   */
  presentFrame?: (
    scale: number,
    tx: number,
    ty: number,
    dpr: number,
    rotation: number,
  ) => boolean;
  /**
   * GPU mode: whether the device has been lost. Read on idle ticks — a
   * GPU-process crash blanks the canvas without any present failing.
   */
  gpuLost?: () => boolean;
}

interface PageGeometry {
  pageId: PageId;
  rect: PageRect; // doc-space (pt)
  /** Index in the model's page vector, for staleness invalidation. */
  index: number;
}

interface TileKey {
  pageId: PageId;
  widthPx: number;
}

interface CachedTile {
  bitmap: ImageBitmap;
  widthPx: number;
  heightPx: number;
  /** The tick it was last drawn in: the LRU order of eviction. */
  usedAt: number;
}

interface RendererOptions {
  /** Width of the snapshot tile in device pixels. Per spec 256–512. */
  snapshotWidthPx?: number;
  /** Background fill drawn beneath pages. Defaults to spec-grey. */
  background?: string;
  /**
   * When true, the worker has claimed the OffscreenCanvas for
   * WebGPU rendering (via `wasm.initGpu`) — the renderer must NOT
   * call `getContext("2d")` on it. The render loop dispatches to
   * `wasm.presentFrame` instead of the blit path.
   */
  gpuActive?: boolean;
  /**
   * Called when `presentFrame` returns false in GPU mode — a skipped
   * frame or a lost device. The worker tells the two apart
   * (`gpuLostReason`) and recovers; the renderer only reports.
   */
  onPresentFailed?: () => void;
  /** The CPU tiles' memory budget, bytes (`TILE_BUDGET_BYTES`). */
  tileBudgetBytes?: number;
}

/**
 * Editor ADR "Performance budgets" (UXI-PRF-004) — the CPU path's tile
 * cache holds at most this many bytes of decoded tiles (4 bytes a pixel).
 * Past it the tiles drawn longest ago go first; a tile on screen this
 * tick never does. 64 MB is ~190 snapshot tiles of a Letter page at
 * 256 px, or ~33 Pixel Preview tiles at 72 ppi: every page of a long
 * document at thumbnail size, a screenful at full size.
 */
export const TILE_BUDGET_BYTES = 64 * 1024 * 1024;

/** Pages next to the visible ones that are rendered ahead, while nothing
 *  on screen is missing (UXI-PRF-005: the viewport first, neighbours next). */
export const PREFETCH_NEIGHBOURS = 2;

const DEFAULT_SNAPSHOT_WIDTH_PX = 256;
const DEFAULT_BACKGROUND = "#e5e7eb";

export class WorkerRenderer {
  private readonly canvas: OffscreenCanvas;
  /**
   * 2D context — `undefined` when the renderer is in GPU mode and
   * the OffscreenCanvas's WebGPU context is owned by Vello via
   * wasm. The render loop checks `gpuActive` first; if not in GPU
   * mode it falls back to `ctx`.
   */
  private readonly ctx: OffscreenCanvasRenderingContext2D | undefined;
  private readonly wasm: RendererWasm;
  private readonly cameraBuffer: CameraBuffer;
  private readonly snapshotWidthPx: number;
  private readonly background: string;
  private readonly gpuActive: boolean;
  private readonly onPresentFailed: (() => void) | undefined;

  /** Tiles in cache; key = `${pageId}:${widthPx}`. */
  private readonly tiles = new Map<string, CachedTile>();
  /** Set of `${pageId}:${widthPx}` requests currently being awaited. */
  private readonly pendingTiles = new Set<string>();
  private readonly tileBudgetBytes: number;
  /** The draw count, the clock of the tiles' LRU. */
  private tickNo = 0;
  /** Since the layout was (re)built: when, and whether a page has shown
   *  yet (the first visible paint, journaled once per layout). */
  private layoutAt = 0;
  private painted = false;
  /** The pages the last draw showed: their tiles are never evicted. */
  private visibleNow: readonly PageGeometry[] = [];
  /** Tiles the engine could not render (no bytes, a throw, a failed
   *  decode), until the page or the layout changes: asked again every
   *  tick, one would hold the loop busy for good. */
  private readonly failedTiles = new Set<string>();

  private dpr = 1;
  /** Page layout in document space. Recomputed when the document changes. */
  private pages: PageGeometry[] = [];

  /** v77 (editor ADR 287) — the engine's view mode, from the
   *  `viewSettingsApplied` reply. Pixel Preview draws the CPU tiles at
   *  72 ppi (one pixel per point) and enlarges them unsmoothed. */
  private viewMode: string = "preview";

  private lastCameraGeneration = -1n;
  /** Set when something changed and the next tick must redraw even if camera is steady. */
  private dirty = true;
  private running = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    canvas: OffscreenCanvas,
    wasm: RendererWasm,
    cameraBuffer: CameraBuffer,
    dpr: number,
    cssWidth: number,
    cssHeight: number,
    opts: RendererOptions = {},
  ) {
    this.canvas = canvas;
    this.gpuActive = opts.gpuActive ?? false;
    this.onPresentFailed = opts.onPresentFailed;
    if (!this.gpuActive) {
      const ctx = canvas.getContext("2d");
      // A failed GPU init can still leave the OffscreenCanvas with a
      // context locked to webgpu, so the 2D fallback may not be
      // available. We log + continue with no compositor; snapshot
      // PNGs flow through `handleMessage` independently of `ctx`.
      this.ctx = ctx ?? undefined;
      if (!ctx) {
        console.warn(
          "OffscreenCanvas 2D context unavailable — live tile compositor disabled (snapshots still work)",
        );
      }
    } else {
      this.ctx = undefined;
    }
    this.wasm = wasm;
    this.cameraBuffer = cameraBuffer;
    this.snapshotWidthPx = opts.snapshotWidthPx ?? DEFAULT_SNAPSHOT_WIDTH_PX;
    this.tileBudgetBytes = opts.tileBudgetBytes ?? TILE_BUDGET_BYTES;
    this.background = opts.background ?? DEFAULT_BACKGROUND;
    this.applySize(dpr, cssWidth, cssHeight);
  }

  /**
   * Refresh the per-page layout from the wasm model. Call after
   * `LoadDocument` succeeds (worker.ts wires this).
   */
  refreshLayout(): void {
    const count = this.wasm.pageCount();
    const sizes: Array<[number, number]> = [];
    const origins: Array<[number, number]> = [];
    const ids: PageId[] = [];
    for (let i = 0; i < count; i++) {
      const info = this.wasm.pageInfo(i);
      if (!info) continue;
      ids.push(info[0]);
      sizes.push([info[1], info[2]]);
      if (info[3] !== undefined && info[4] !== undefined) {
        origins.push([info[3], info[4]]);
      }
    }
    // Each page at its place on the canvas; an older engine reports none
    // and the pages stack.
    const rects = layoutPages(sizes, origins);
    this.pages = ids.map((pageId, i) => ({ pageId, rect: rects[i], index: i }));
    // New document → previous tiles are stale. Clear them.
    for (const t of this.tiles.values()) t.bitmap.close();
    this.tiles.clear();
    this.pendingTiles.clear();
    this.dirty = true;
    this.layoutAt = performance.now();
    this.painted = false;
    this.failedTiles.clear();
  }

  /** The decoded bytes the tile cache holds now. */
  tileBytes(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.widthPx * t.heightPx * 4;
    return n;
  }

  /** One CPU draw with the camera as it is now, outside the loop (the
   *  unit tests drive the schedule with it). */
  drawNow(): void {
    this.draw(this.cameraBuffer.read());
  }

  /** How many tiles the cache holds (tests, the perf probe). */
  tileCount(): number {
    return this.tiles.size;
  }

  applySize(dpr: number, cssWidth: number, cssHeight: number): void {
    this.dpr = dpr;
    // In GPU mode the surface owns the bitmap dimensions through
    // `surface.configure()` (worker.ts also calls `wasm.resizeGpu`).
    // Setting canvas.width/height directly here would invalidate the
    // WebGPU surface — skip the resize when GPU is active.
    if (!this.gpuActive) {
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    this.dirty = true;
  }

  /**
   * v77 — the view mode changed (`viewSettingsApplied`): every tile was
   * drawn in the old mode, so all go, and both paths redraw (the GPU
   * scene cache is keyed by the mode on the wasm side).
   */
  setViewMode(mode: string): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.markDirty([]);
  }

  /** The tile width for `page`: the fixed snapshot width, or the page's
   *  own width in points in Pixel Preview (72 ppi). */
  private tileWidthFor(page: PageGeometry): number {
    if (this.viewMode === "pixelPreview") {
      return Math.max(1, Math.round(page.rect.w));
    }
    return this.snapshotWidthPx;
  }

  /**
   * Mark the next tick as dirty so it redraws even if the camera
   * generation hasn't changed. Called by worker.ts after the wasm
   * reports `mutationApplied` / `undoApplied` / `redoApplied`. On the
   * CPU path it also drops cached tiles for the affected pages so
   * the next draw fetches fresh PNG bytes instead of blitting stale
   * snapshots; on the GPU path the worker already cleared its
   * scene_cache so presentFrame rebuilds.
   */
  markDirty(pageIds: ReadonlyArray<PageId> = []): void {
    this.dirty = true;
    if (pageIds.length === 0) {
      this.failedTiles.clear();
      for (const t of this.tiles.values()) t.bitmap.close();
      this.tiles.clear();
      return;
    }
    // Every width of the page goes (Pixel Preview's 72 ppi tile too).
    const prefixes = pageIds.map((pageId) => `${pageId}:`);
    for (const key of [...this.failedTiles]) {
      if (prefixes.some((p) => key.startsWith(p))) this.failedTiles.delete(key);
    }
    for (const [key, cached] of [...this.tiles]) {
      if (!prefixes.some((p) => key.startsWith(p))) continue;
      cached.bitmap.close();
      this.tiles.delete(key);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.loopHandle !== null) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
  }

  private tick = (): void => {
    if (!this.running) return;
    this.loopHandle = setTimeout(this.tick, 16);
    const generation = this.cameraBuffer.generation();
    if (!this.dirty && generation === this.lastCameraGeneration) {
      // Nothing to draw, but a lost device has already blanked what is on
      // screen: one flag read per idle tick lets the worker recover now
      // rather than at the next pan or edit.
      if (this.gpuActive && this.wasm.gpuLost?.()) this.onPresentFailed?.();
      return;
    }
    this.lastCameraGeneration = generation;
    this.dirty = false;
    const camera = this.cameraBuffer.read();
    if (this.gpuActive && this.wasm.presentFrame) {
      // GPU hot path: hand the camera to wasm; wasm builds the
      // composite Vello scene and presents directly to the surface.
      // No CPU work in this branch.
      //
      // ADR 025 — two `performance.now()` calls per frame buy the single
      // highest-value measurement in the editor: how long a present actually
      // takes. The HUD has shown FPS since W1 with no way to tell whether a
      // dropped frame was the GPU, the layout or the main thread. The entry
      // is an `aggregate` code, so this emits ONE rollup per second, never
      // per frame.
      const t0 = performance.now();
      const presented = this.wasm.presentFrame(
        camera.scale,
        camera.tx,
        camera.ty,
        this.dpr,
        camera.rotation ?? 0,
      );
      if (!presented) {
        // Nothing reached the screen: draw again next tick, and let the
        // worker find out why (a lost device stays lost until recovered).
        this.dirty = true;
        this.onPresentFailed?.();
      } else if (!this.painted && this.pages.length > 0) {
        // The GPU path builds every visible page's scene before its first
        // present: that present is the first visible paint.
        this.notePainted(true);
      }
      workerJournal.record({
        code: "worker.frame",
        durMs: performance.now() - t0,
        data: { gpu: true },
      });
      return;
    }
    const t0 = performance.now();
    this.draw(camera);
    workerJournal.record({
      code: "worker.frame",
      durMs: performance.now() - t0,
      data: { gpu: false },
    });
  };

  private draw(camera: Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Reset transform + background.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply the camera × DPR transform. The camera operates in CSS
    // pixels (the main thread writes it that way for input events);
    // we multiply by DPR so the doc-space units land on device
    // pixels. setTransform = a, b, c, d, e, f corresponds to
    // matrix(scale*dpr, 0, 0, scale*dpr, tx*dpr, ty*dpr).
    const k = camera.scale * this.dpr;
    // v77 — Rotate View turns the document about its origin.
    const r = camera.rotation ?? 0;
    const c = Math.cos(r) * k;
    const sn = Math.sin(r) * k;
    ctx.setTransform(c, sn, -sn, c, camera.tx * this.dpr, camera.ty * this.dpr);
    // Pixel Preview's 72 ppi tiles are enlarged as blocks.
    ctx.imageSmoothingEnabled = this.viewMode !== "pixelPreview";

    // Per-page draws. Visibility-cull by viewport bounds in doc
    // space so we don't issue drawImage for off-screen pages —
    // matters for the 500-page target. The doc-space viewport is
    // the inverse camera mapping of the device viewport.
    const docViewport = this.docSpaceViewport(camera);
    this.tickNo += 1;

    // PROGRESSIVE (editor ADR "Performance budgets", UXI-PRF-001/005):
    // the visible pages draw what they have; of those still missing a
    // tile, ONE is rendered per tick — the nearest to the viewport's
    // centre — and the next tick asks again from the camera it then
    // has. A page that scrolled out before its turn is never rendered:
    // nothing is queued that the camera could make stale. With every
    // visible page drawn, one neighbour per tick is rendered ahead.
    const visible: PageGeometry[] = [];
    const missing: PageGeometry[] = [];
    for (const page of this.pages) {
      if (!intersects(page.rect, docViewport)) continue;
      visible.push(page);
      if (!this.drawPage(page)) missing.push(page);
    }
    const centre = {
      x: docViewport.x + docViewport.w / 2,
      y: docViewport.y + docViewport.h / 2,
    };
    const waiting = (p: PageGeometry) => {
      const key = tileKey({ pageId: p.pageId, widthPx: this.tileWidthFor(p) });
      return this.pendingTiles.has(key) || this.failedTiles.has(key);
    };
    const next =
      nearest(
        missing.filter((p) => !waiting(p)),
        centre,
      ) ??
      (missing.length === 0 ? this.neighbourToPrefetch(visible, centre) : null);
    if (next) {
      // Rendered now, shown next tick (the decode is asynchronous).
      void this.loadTile(next.pageId, this.tileWidthFor(next));
      this.dirty = true;
    }
    // The first visible paint: the first page that shows its content.
    if (!this.painted && visible.length > missing.length) {
      this.notePainted(false);
    }
    this.visibleNow = visible;
    this.evictOverBudget(visible);
  }

  /** The first page that shows after a layout: journaled once (the
   *  perf probe's first visible paint, from the worker's own clock). */
  private notePainted(gpu: boolean): void {
    this.painted = true;
    workerJournal.record({
      code: "worker.firstPaint",
      durMs: performance.now() - this.layoutAt,
      data: { pages: this.pages.length, gpu },
    });
  }

  /** The nearest page within `PREFETCH_NEIGHBOURS` of the visible ones
   *  that has no tile yet, or null. */
  private neighbourToPrefetch(
    visible: readonly PageGeometry[],
    centre: { x: number; y: number },
  ): PageGeometry | null {
    if (visible.length === 0) return null;
    const lo = Math.min(...visible.map((p) => p.index));
    const hi = Math.max(...visible.map((p) => p.index));
    const around = this.pages.filter(
      (p) =>
        (p.index < lo && p.index >= lo - PREFETCH_NEIGHBOURS) ||
        (p.index > hi && p.index <= hi + PREFETCH_NEIGHBOURS),
    );
    return nearest(
      around.filter((p) => {
        const key = tileKey({
          pageId: p.pageId,
          widthPx: this.tileWidthFor(p),
        });
        return (
          !this.tiles.has(key) &&
          !this.pendingTiles.has(key) &&
          !this.failedTiles.has(key)
        );
      }),
      centre,
    );
  }

  /** Drop the tiles drawn longest ago until the cache is in budget; the
   *  tiles of `visible` pages stay whatever it costs. */
  private evictOverBudget(visible: readonly PageGeometry[]): void {
    let bytes = this.tileBytes();
    if (bytes <= this.tileBudgetBytes) return;
    const keep = new Set(visible.map((p) => `${p.pageId}:`));
    const oldest = [...this.tiles.entries()]
      .filter(([key]) => ![...keep].some((k) => key.startsWith(k)))
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, tile] of oldest) {
      if (bytes <= this.tileBudgetBytes) break;
      tile.bitmap.close();
      this.tiles.delete(key);
      bytes -= tile.widthPx * tile.heightPx * 4;
    }
  }

  /** Draw `page`; false when its tile is not there yet. */
  private drawPage(page: PageGeometry): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    const r = page.rect;

    // Page chrome: white background + thin border. The browser
    // device-pixel-rounds 1px strokes so they stay visible at any
    // camera scale.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // Bind a tile to this page. Sub-phase A only has one tile size
    // (snapshot). Sub-phase B introduces mid-res; this method is
    // where the tier decision lives.
    const tile = this.bestTileFor(page);
    if (tile) {
      ctx.drawImage(tile.bitmap, r.x, r.y, r.w, r.h);
    }

    // Border drawn last so it sits on top of the tile.
    ctx.lineWidth = 1 / (this.dpr || 1);
    ctx.strokeStyle = "#cccccc";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return tile !== undefined;
  }

  /** The page's tile, or undefined: the draw plans the render (`draw`),
   *  so a miss here asks for nothing. */
  private bestTileFor(page: PageGeometry): CachedTile | undefined {
    const widthPx = this.tileWidthFor(page);
    const cached = this.tiles.get(tileKey({ pageId: page.pageId, widthPx }));
    if (cached) cached.usedAt = this.tickNo;
    return cached;
  }

  /**
   * Async tile load. Decodes PNG bytes into an ImageBitmap, stores
   * in the cache, marks dirty so the next render-loop tick blits it.
   * Deduplicates concurrent requests for the same key.
   */
  private async loadTile(pageId: PageId, widthPx: number): Promise<void> {
    const key = tileKey({ pageId, widthPx });
    if (this.pendingTiles.has(key) || this.tiles.has(key)) return;
    this.pendingTiles.add(key);
    try {
      const bytes = this.wasm.renderTilePng(pageId, widthPx);
      if (!bytes) {
        // Unknown page or no document — drop, and do not ask again.
        this.failedTiles.add(key);
        return;
      }
      // ImageBitmap is the fastest decode path in workers — the
      // browser does the PNG decode + GPU upload in parallel and
      // returns a transferable handle.
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      this.tiles.set(key, {
        bitmap,
        widthPx: bitmap.width,
        heightPx: bitmap.height,
        usedAt: this.tickNo,
      });
      this.evictOverBudget(this.visibleNow);
      this.dirty = true;
    } catch {
      // The engine threw or the decode failed: the page shows its outline
      // (the chrome border) until it changes, and the loop goes on.
      this.failedTiles.add(key);
    } finally {
      this.pendingTiles.delete(key);
    }
  }

  private docSpaceViewport(camera: Camera): PageRect {
    // Device-pixel viewport is (0, 0, canvas.width, canvas.height).
    // Camera transform: doc → device. Invert to find which doc-space
    // rectangle is visible.
    const k = camera.scale * this.dpr;
    if (k <= 0) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    // The device viewport's corners mapped back to document space; a
    // rotated view (v77) shows their bounding box.
    const r = camera.rotation ?? 0;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    const toDoc = (px: number, py: number): [number, number] => {
      const u = (px - camera.tx * this.dpr) / k;
      const v = (py - camera.ty * this.dpr) / k;
      return [c * u + sn * v, -sn * u + c * v];
    };
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pts = [toDoc(0, 0), toDoc(w, 0), toDoc(w, h), toDoc(0, h)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
}

/** The page whose centre is nearest `at`, or null. */
function nearest(
  pages: readonly PageGeometry[],
  at: { x: number; y: number },
): PageGeometry | null {
  let best: PageGeometry | null = null;
  let bestD = Infinity;
  for (const p of pages) {
    const dx = p.rect.x + p.rect.w / 2 - at.x;
    const dy = p.rect.y + p.rect.h / 2 - at.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function tileKey(k: TileKey): string {
  return `${k.pageId}:${k.widthPx}`;
}

function intersects(a: PageRect, b: PageRect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
