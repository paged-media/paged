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

// Adjust handles (slide ADR 717): PowerPoint's yellow handles on a selected
// live preset. Dragging one changes the preset's adjust values (a rounded
// rectangle's corner radius, an arrow's head, a callout's tip) and draws
// the shape again, one undo step on release.
//
// The handles are an overlay contribution (`contribute.overlay`, rendering
// "overlay"): the host draws it in document space above the selection
// chrome, and a handle takes the pointer before the canvas does. Where they
// are and what a drag writes is the slide engine's (one wasm call each);
// this file keeps the selection's state and draws it. The PM-0014
// overlay-handles door (extensions 340) is not on main; once it is, the
// handles move to it.

import type {
  BundleHost,
  Disposable,
  ElementId,
  OverlayContribution,
  OverlayProps,
} from "@paged-media/plugin-api";
import * as React from "react";

import type {
  LiveElement,
  LiveWrite,
  PageHandle,
  SlideEngine,
} from "./engine.js";
import { liveElements, writeMutation } from "./live-presets.js";

export const ADJUST_OVERLAY_ID = "media.paged.slide.overlay.adjustHandles";

/** What the overlay draws: the selected preset's handles, on its page. */
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

/** Handle size on screen, CSS px (PowerPoint's yellow diamond). */
const HANDLE_PX = 5;

/** The overlay contribution that draws `model`'s handles. */
export function adjustHandlesOverlay(model: HandlesModel): OverlayContribution {
  const Render: React.FC<OverlayProps> = ({ camera, pageRects }) => {
    const s = React.useSyncExternalStore(model.subscribe, model.snapshot);
    const rect = s.pageId ? pageRects.get(s.pageId) : undefined;
    if (!rect || s.handles.length === 0)
      return (
        <g
          data-slide-adjust-handles=""
          data-count={0}
          data-page={s.pageId ?? ""}
        />
      );
    const inv = 1 / (camera.scale || 1);
    const onDown = (index: number) => (e: React.PointerEvent<SVGElement>) => {
      // Win the pointer before the canvas starts a move or a marquee.
      e.preventDefault();
      e.stopPropagation();
      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      const box = svg?.getBoundingClientRect();
      const toPage = (
        ev: PointerEvent | React.PointerEvent,
      ): [number, number] => [
        (ev.clientX - (box?.left ?? 0) - camera.tx) / camera.scale - rect.x,
        (ev.clientY - (box?.top ?? 0) - camera.ty) / camera.scale - rect.y,
      ];
      let last: LiveWrite[] = [];
      let pending = Promise.resolve();
      const move = (ev: PointerEvent) => {
        const p = toPage(ev);
        pending = pending.then(async () => {
          last = await model.drag(index, p);
        });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        move(ev);
        void pending.then(() =>
          last.length ? model.commit(last) : model.cancel(),
        );
      };
      const cancel = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        model.cancel();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    };
    return (
      <g
        data-slide-adjust-handles=""
        transform={`translate(${rect.x} ${rect.y})`}
      >
        {s.preview ? (
          <path
            d={s.preview}
            fill="none"
            stroke="var(--overlay-selection, #1a73e8)"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ) : null}
        {s.handles.map((h) => (
          <path
            key={h.index}
            data-slide-adjust-handle={h.index}
            transform={`translate(${h.pos[0]} ${h.pos[1]}) scale(${inv})`}
            d={`M0 ${-HANDLE_PX} L${HANDLE_PX} 0 L0 ${HANDLE_PX} L${-HANDLE_PX} 0 Z`}
            fill="#ffd400"
            stroke="#5c4a00"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: "default", pointerEvents: "all" }}
            onPointerDown={onDown(h.index)}
          />
        ))}
      </g>
    );
  };
  return { id: ADJUST_OVERLAY_ID, render: Render, z: 330 };
}
