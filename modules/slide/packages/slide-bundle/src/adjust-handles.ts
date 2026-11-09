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

// Adjust handles (slide ADR 717): PowerPoint's handles on a selected live
// preset. Dragging one changes the preset's adjust values (a rounded
// rectangle's corner radius, an arrow's head, a callout's tip) and draws
// the shape again, one undo step on release.
//
// The handles are a host handle set (`host.overlay.handles`, extensions ADR
// 339) the host draws and hit-tests at a constant screen size, and the
// host's own Selection tools hand a drag on one to this bundle
// (`onHostDrag`, extensions ADR 1102): slide contributes no tool, the
// selection is the host's. The drag's outline preview is a retained
// overlay layer. Where the handles are and what a drag writes is the slide
// engine's (one wasm call each, dml-geom's handles); this file keeps the
// selection's state and hands it to the host.

import type {
  BundleHost,
  Disposable,
  ElementId,
  ToolPreviewPath,
} from "@paged-media/plugin-api";

import type {
  LiveElement,
  LiveWrite,
  PageHandle,
  SlideEngine,
} from "./engine.js";
import { liveElements, writeMutation } from "./live-presets.js";

/** The handle set's and the preview layer's ids within the bundle. */
export const ADJUST_HANDLE_SET = "adjust";
export const ADJUST_PREVIEW_LAYER = "adjustPreview";

/** What the handles show: the selected preset's handles, on its page. */
export interface HandlesState {
  pageId: string | null;
  target: LiveElement | null;
  /** The elements of the target's page (its companions among them). */
  elements: readonly LiveElement[];
  ids: ReadonlyMap<string, ElementId>;
  handles: readonly PageHandle[];
  /** While dragging: the outline the drag would draw (page space). */
  preview: string | null;
}

const EMPTY: HandlesState = {
  pageId: null,
  target: null,
  elements: [],
  ids: new Map(),
  handles: [],
  preview: null,
};

/** The selection's handles, kept current across selection and document
 *  changes. */
export class HandlesModel implements Disposable {
  private state: HandlesState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly subs: Disposable[] = [];
  private generation = 0;
  private dragging = false;
  /** The element selection as last announced (null: ask the host). */
  private selected: readonly ElementId[] | null = null;

  constructor(
    private readonly host: BundleHost,
    private readonly engine: () => Promise<SlideEngine>,
  ) {
    this.subs.push(
      // The ids the change carries: the host's own copy of the selection
      // may not have caught up when the change is announced.
      host.selection.onDidChange((ids) => {
        this.selected = ids;
        void this.refresh();
      }),
      host.document.onDidChange(() => void this.refresh()),
    );
    void this.refresh();
  }

  snapshot = (): HandlesState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: HandlesState) {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Read the selected element's handles again. */
  async refresh(): Promise<void> {
    try {
      await this.read();
    } catch (err) {
      this.host.log.warn(`paged.slide adjust handles: ${String(err)}`);
    }
  }

  private async read(): Promise<void> {
    if (this.dragging) return;
    const gen = ++this.generation;
    const sel = this.selected ?? this.host.selection.get();
    if (sel.length !== 1 || sel[0]!.kind !== "polygon") {
      if (this.state !== EMPTY) this.set(EMPTY);
      return;
    }
    const id = sel[0]!;
    const [g] = await this.host.document.elementGeometry([id]);
    const page = g?.pageId ?? null;
    if (!page) {
      this.set(EMPTY);
      return;
    }
    const byPage = await liveElements(this.host, new Set([page]));
    const list = byPage.get(page) ?? [];
    const target = list.find((x) => x.element.id === id.id)?.element ?? null;
    const handles = target ? (await this.engine()).handles(target) : [];
    if (gen !== this.generation) return;
    this.set({
      pageId: page,
      target,
      elements: list.map((x) => x.element),
      ids: new Map(list.map((x) => [x.element.id, x.id])),
      handles,
      preview: null,
    });
  }

  /** The writes a drag of handle `index` to `point` (page) makes. */
  async drag(index: number, point: [number, number]): Promise<LiveWrite[]> {
    const s = this.state;
    if (!s.target) return [];
    this.dragging = true;
    const writes = (await this.engine()).adjust(
      s.elements,
      s.target.id,
      index,
      point,
    );
    const preview = writes.find((w) => w.id === s.target?.id)?.path ?? null;
    this.set({ ...this.state, preview });
    return writes;
  }

  /** Release: write the drag's answer as one undo step. */
  async commit(writes: readonly LiveWrite[]): Promise<void> {
    this.dragging = false;
    const m = writeMutation(writes, this.state.ids);
    this.set({ ...this.state, preview: null });
    if (m) {
      const out = await this.host.document.mutate(m);
      if (!out.applied)
        this.host.log.warn(
          `paged.slide adjust handle: the engine refused (${JSON.stringify(out.error)})`,
        );
    }
    await this.refresh();
  }

  cancel() {
    this.dragging = false;
    this.set({ ...this.state, preview: null });
  }

  dispose() {
    for (const s of this.subs.splice(0)) s.dispose();
    this.listeners.clear();
  }
}

/** SVG path data as the slide engine writes it (`M x y` then `C` cubics,
 *  `Z` closing a subpath; slide-native `svg_path`) as the host's cubic
 *  preview shapes, one per subpath, dashed. */
export function previewPaths(pageId: string, d: string): ToolPreviewPath[] {
  const nums = (t: string) =>
    t
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
  type Anchor = {
    anchor: [number, number];
    left: [number, number];
    right: [number, number];
  };
  const out: ToolPreviewPath[] = [];
  let anchors: Anchor[] = [];
  const flush = (close: boolean) => {
    if (anchors.length === 0) return;
    if (close && anchors.length > 1) {
      // The closing cubic ends on the first anchor: fold it back in.
      const last = anchors[anchors.length - 1]!;
      const first = anchors[0]!;
      if (
        Math.abs(last.anchor[0] - first.anchor[0]) < 1e-6 &&
        Math.abs(last.anchor[1] - first.anchor[1]) < 1e-6
      ) {
        first.left = last.left;
        anchors.pop();
      }
    }
    out.push({ pageId, anchors, close, dashed: true });
    anchors = [];
  };
  for (const m of d.matchAll(/([MCZ])([^MCZ]*)/g)) {
    const v = nums(m[2] ?? "");
    if (m[1] === "M" && v.length >= 2) {
      flush(false);
      const p: [number, number] = [v[0]!, v[1]!];
      anchors.push({ anchor: p, left: p, right: p });
    } else if (m[1] === "C") {
      for (let i = 0; i + 5 < v.length; i += 6) {
        const prev = anchors[anchors.length - 1];
        if (!prev) break;
        prev.right = [v[i]!, v[i + 1]!];
        const p: [number, number] = [v[i + 4]!, v[i + 5]!];
        anchors.push({ anchor: p, left: [v[i + 2]!, v[i + 3]!], right: p });
      }
    } else if (m[1] === "Z") {
      flush(true);
    }
  }
  flush(false);
  return out;
}

/** Show `model`'s handles as a host handle set and hand the host
 *  Selection tools' drags on them to the model. The drag's writes land
 *  in one `document.mutate` on release: one undo step. */
export function mountAdjustHandles(
  host: BundleHost,
  model: HandlesModel,
): Disposable {
  const set = host.overlay.handles(ADJUST_HANDLE_SET);
  const preview = host.overlay.layer(ADJUST_PREVIEW_LAYER);
  let active: string | null = null;
  const draw = () => {
    const s = model.snapshot();
    if (!s.pageId || s.handles.length === 0) set.clear();
    else
      set.set(
        { pageId: s.pageId },
        s.handles.map((h) => ({
          id: String(h.index),
          at: h.pos,
          kind: "round" as const,
          ...(active === String(h.index) ? { active: true } : {}),
        })),
      );
    preview.set(s.pageId && s.preview ? previewPaths(s.pageId, s.preview) : []);
  };
  const unsubscribe = model.subscribe(draw);
  draw();

  // The engine answers each move asynchronously: moves queue behind each
  // other, and the release (or a cancel) waits for the last.
  let pending: Promise<void> = Promise.resolve();
  let last: LiveWrite[] = [];
  const queue = (index: number, point: [number, number]) => {
    pending = pending
      .then(async () => {
        last = await model.drag(index, point);
      })
      .catch((err) =>
        host.log.warn(`paged.slide adjust handle: ${String(err)}`),
      );
  };
  const drag = set.onHostDrag({
    onStart(d) {
      active = d.id;
      last = [];
      draw();
    },
    onMove(d) {
      queue(Number(d.id), d.pagePoint);
    },
    onEnd(d) {
      queue(Number(d.id), d.pagePoint);
      active = null;
      void pending.then(() =>
        last.length ? model.commit(last) : model.cancel(),
      );
    },
    onCancel() {
      active = null;
      void pending.then(() => model.cancel());
    },
  });
  return {
    dispose() {
      drag.dispose();
      unsubscribe();
      preview.dispose();
      set.dispose();
    },
  };
}
