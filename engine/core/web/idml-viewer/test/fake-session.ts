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

import type {
  SessionDiagnostics,
  SessionPagesLayout,
  SessionRaster,
  ViewerSessionLike,
} from "../src/session.js";

export interface PresentCall {
  zoom: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
  onlyPage: number | null | undefined;
}

const OK: SessionDiagnostics = { ok: true, messages: [] };

/** Three US-letter pages, 24pt gap — mirrors the wasm layout. */
export function letterLayout(pages = 3): SessionPagesLayout {
  const out: SessionPagesLayout = { gapPt: 24, pages: [] };
  let y = 0;
  for (let i = 0; i < pages; i++) {
    out.pages.push({ index: i, yPt: y, widthPt: 612, heightPt: 792 });
    y += 792 + 24;
  }
  return out;
}

export class FakeSession implements ViewerSessionLike {
  presents: PresentCall[] = [];
  loads = 0;
  pageSets: number[] = [];
  freed = false;
  thumbnails: Array<{ index: number; width: number }> = [];
  layout: SessionPagesLayout;
  loadResult: SessionDiagnostics = OK;
  bindResult: SessionDiagnostics = OK;

  constructor(layout: SessionPagesLayout = letterLayout()) {
    this.layout = layout;
  }

  load(): SessionDiagnostics {
    this.loads += 1;
    return this.loadResult;
  }

  register_font(): void {}

  page_count(): number {
    return this.layout.pages.length;
  }

  set_page(index: number): void {
    this.pageSets.push(index);
  }

  page_layout(): SessionPagesLayout {
    return this.layout;
  }

  present(
    zoom: number,
    scrollX: number,
    scrollY: number,
    dpr: number,
    onlyPage?: number | null,
  ): SessionDiagnostics {
    this.presents.push({ zoom, scrollX, scrollY, dpr, onlyPage });
    return OK;
  }

  render_to_canvas_main(): Promise<SessionDiagnostics> {
    return Promise.resolve(this.bindResult);
  }

  render_page_to_bytes(index: number, targetWidthPx: number): Promise<SessionRaster> {
    this.thumbnails.push({ index, width: targetWidthPx });
    const height = Math.ceil((792 / 612) * targetWidthPx);
    return Promise.resolve({
      width: targetWidthPx,
      height,
      rgba: new Uint8Array(targetWidthPx * height * 4),
    });
  }

  resize(): void {}

  free(): void {
    this.freed = true;
  }
}

/** A 800×600 CSS-px canvas stub — enough surface for the viewer. */
export function fakeCanvas(): HTMLCanvasElement {
  const listeners = new Map<string, Set<EventListener>>();
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(type: string, fn: EventListener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event: Event): boolean {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 } as DOMRect;
    },
    hasAttribute() {
      return true;
    },
    setAttribute() {},
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** Synchronous frame scheduler for deterministic tests. */
export function syncSchedule(frame: () => void): void {
  frame();
}
