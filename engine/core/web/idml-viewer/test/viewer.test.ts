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

import { describe, expect, it } from "bun:test";

import { createViewer, ViewerError } from "../src/viewer.js";
import { adaptSession } from "../src/session.js";
import {
  fakeCanvas,
  FakeSession,
  letterLayout,
  syncSchedule,
} from "./fake-session.js";

async function makeViewer(session = new FakeSession()) {
  const canvas = fakeCanvas();
  const viewer = await createViewer({
    canvas,
    session,
    schedule: syncSchedule,
    devicePixelRatio: 2,
  });
  return { viewer, session, canvas };
}

const IDML = new Uint8Array([0x50, 0x4b]); // any bytes — the fake ignores them

describe("load", () => {
  it("binds, lays out, fits page 0 and emits loaded", async () => {
    const { viewer, session } = await makeViewer();
    const events: number[] = [];
    viewer.on("loaded", (e) => events.push(e.pageCount));

    await viewer.load(IDML);

    expect(session.loads).toBe(1);
    expect(events).toEqual([3]);
    expect(viewer.pageCount).toBe(3);
    expect(viewer.currentPage).toBe(0);
    // fit("page") at 800×600 for 612×792 → zoom ≈ 600/792*0.95.
    expect(viewer.zoom).toBeCloseTo((600 / 792) * 0.95, 5);
    // A present was scheduled with the camera + dpr.
    expect(session.presents.length).toBeGreaterThan(0);
    expect(session.presents.at(-1)?.dpr).toBe(2);
  });

  it("is repeatable — a second load rebinds nothing and re-fits", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    await viewer.load(IDML);
    expect(session.loads).toBe(2);
    expect(viewer.currentPage).toBe(0);
  });

  it("maps parse failures to ViewerError PARSE_ERROR and emits error", async () => {
    const session = new FakeSession();
    session.loadResult = {
      ok: false,
      messages: [
        { severity: "error", code: "open", message: "open IDML: bad zip" },
      ],
    };
    const { viewer } = await makeViewer(session);
    const seen: ViewerError[] = [];
    viewer.on("error", (e) => seen.push(e));

    await expect(viewer.load(IDML)).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.diagnostics?.messages[0]?.code).toBe("open");
  });

  it("maps GPU bind failures to GPU_UNAVAILABLE", async () => {
    const session = new FakeSession();
    session.bindResult = {
      ok: false,
      messages: [
        { severity: "error", code: "gpu_init", message: "WebGPU init failed" },
      ],
    };
    const { viewer } = await makeViewer(session);
    await expect(viewer.load(IDML)).rejects.toMatchObject({
      code: "GPU_UNAVAILABLE",
    });
  });

  it("a rejecting session factory becomes GPU_UNAVAILABLE", async () => {
    await expect(
      createViewer({
        canvas: fakeCanvas(),
        session: () => Promise.reject(new Error("navigator.gpu is undefined")),
      }),
    ).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });
});

describe("GPU device loss", () => {
  it("a lost device is replaced once and the page presents again", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    const seen: ViewerError[] = [];
    viewer.on("error", (e) => seen.push(e));
    session.lostPresents = 1;
    const before = session.presents.length;

    viewer.zoomIn();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.recoveries).toBe(1);
    // The failed present, then the one after recovery.
    expect(session.presents.length).toBe(before + 2);
    expect(seen).toHaveLength(0);
  });

  it("a device the browser will not replace becomes GPU_UNAVAILABLE", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    const seen: ViewerError[] = [];
    viewer.on("error", (e) => seen.push(e));
    session.lostPresents = 1;
    session.recoverResult = false;

    viewer.zoomIn();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.recoveries).toBe(1);
    expect(seen.map((e) => e.code)).toEqual(["GPU_UNAVAILABLE"]);
  });
});

describe("camera surface", () => {
  it("zoomChanged/scrollChanged fire once per change", async () => {
    const { viewer } = await makeViewer();
    await viewer.load(IDML);
    const zooms: number[] = [];
    const scrolls: Array<{ x: number; y: number }> = [];
    viewer.on("zoomChanged", (e) => zooms.push(e.zoom));
    viewer.on("scrollChanged", (e) => scrolls.push(e));

    viewer.setZoom(viewer.zoom); // no-op → no events
    expect(zooms).toHaveLength(0);

    viewer.zoomIn();
    expect(zooms).toHaveLength(1);
    expect(zooms[0]).toBeCloseTo((600 / 792) * 0.95 * Math.SQRT2, 5);

    viewer.scrollBy(0, -40);
    expect(scrolls.length).toBeGreaterThan(0);
  });

  it("presents with the rAF batch — one present per applied change", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    const before = session.presents.length;
    viewer.zoomIn();
    expect(session.presents.length).toBe(before + 1);
  });

  it("clamps zoom to min/max", async () => {
    const { viewer } = await makeViewer();
    await viewer.load(IDML);
    viewer.setZoom(99);
    expect(viewer.zoom).toBe(viewer.maxZoom);
    viewer.setZoom(0.000001);
    expect(viewer.zoom).toBe(viewer.minZoom);
  });
});

describe("pages", () => {
  it("goToPage scrolls the page into view and emits pageChanged", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    const pages: number[] = [];
    viewer.on("pageChanged", (e) => pages.push(e.page));

    viewer.goToPage(2);
    expect(viewer.currentPage).toBe(2);
    expect(pages).toEqual([2]);
    expect(session.pageSets.at(-1)).toBe(2);
    expect(pages.at(-1)).toBe(2);
  });

  it("goToPage clamps to the page range", async () => {
    const { viewer } = await makeViewer();
    await viewer.load(IDML);
    viewer.goToPage(99);
    expect(viewer.currentPage).toBe(2);
    viewer.goToPage(-5);
    expect(viewer.currentPage).toBe(0);
  });

  it("scrolling continuous mode derives the current page", async () => {
    const { viewer } = await makeViewer();
    await viewer.load(IDML);
    const pages: number[] = [];
    viewer.on("pageChanged", (e) => pages.push(e.page));
    // Scroll page 1's middle under the viewport centre.
    const z = viewer.zoom;
    viewer.scrollTo((800 - 612 * z) / 2, 600 / 2 - (816 + 396) * z);
    expect(viewer.currentPage).toBe(1);
    expect(pages).toContain(1);
  });

  it("single mode presents only the current page at y=0", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    viewer.layoutMode("single");
    viewer.goToPage(1);
    const last = session.presents.at(-1);
    expect(last?.onlyPage).toBe(1);
    expect(viewer.layoutMode()).toBe("single");
  });

  it("renderPageThumbnail delegates with the requested width", async () => {
    const { viewer, session } = await makeViewer();
    await viewer.load(IDML);
    const raster = await viewer.renderPageThumbnail(2, { width: 240 });
    expect(raster.width).toBe(240);
    expect(session.thumbnails).toEqual([{ index: 2, width: 240 }]);
  });
});

describe("dispose", () => {
  it("detaches input, clears listeners, frees the session", async () => {
    const { viewer, session, canvas } = await makeViewer();
    await viewer.load(IDML);
    const counts = canvas as unknown as {
      listenerCount(type: string): number;
    };
    expect(counts.listenerCount("wheel")).toBe(1);

    let fired = 0;
    viewer.on("zoomChanged", () => fired++);
    viewer.dispose();

    expect(session.freed).toBe(true);
    expect(counts.listenerCount("wheel")).toBe(0);
    expect(counts.listenerCount("pointerdown")).toBe(0);
    expect(counts.listenerCount("keydown")).toBe(0);

    const before = session.presents.length;
    viewer.zoomIn(); // post-dispose: no event, no present
    expect(fired).toBe(0);
    expect(session.presents.length).toBe(before);
    viewer.dispose(); // idempotent
  });
});

/** Resize the stub canvas the way a layout change does. */
function setCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  const box = canvas as unknown as {
    clientWidth: number;
    clientHeight: number;
  };
  box.clientWidth = width;
  box.clientHeight = height;
}

describe("resize", () => {
  it("resize() gives the session the new size and presents again", async () => {
    const { viewer, session, canvas } = await makeViewer();
    await viewer.load(IDML);
    expect(session.resizes.at(-1)).toEqual({ width: 800, height: 600, dpr: 2 });
    const resizes = session.resizes.length;
    const presents = session.presents.length;

    viewer.resize(); // nothing changed: no resize, no present
    expect(session.resizes.length).toBe(resizes);
    expect(session.presents.length).toBe(presents);

    setCanvasSize(canvas, 1000, 700);
    viewer.resize();

    expect(session.resizes.at(-1)).toEqual({
      width: 1000,
      height: 700,
      dpr: 2,
    });
    expect(session.presents.length).toBe(presents + 1);
  });

  it("keeps the document point at the viewport centre", async () => {
    const { viewer, canvas } = await makeViewer();
    await viewer.load(IDML);
    viewer.setZoom(2); // larger than the viewport on both axes
    viewer.scrollTo(-100, -500);
    const before = viewer.scroll;

    setCanvasSize(canvas, 900, 500);
    viewer.resize();

    expect(viewer.scroll).toEqual({ x: before.x + 50, y: before.y - 50 });
  });

  it("follows a ResizeObserver where the browser has one", async () => {
    const scope = globalThis as { ResizeObserver?: unknown };
    const original = scope.ResizeObserver;
    const observers: Array<{
      notify: () => void;
      targets: unknown[];
      connected: boolean;
    }> = [];
    scope.ResizeObserver = class {
      private readonly entry;
      constructor(callback: () => void) {
        this.entry = {
          notify: callback,
          targets: [] as unknown[],
          connected: true,
        };
        observers.push(this.entry);
      }
      observe(target: unknown): void {
        this.entry.targets.push(target);
      }
      disconnect(): void {
        this.entry.connected = false;
      }
    };
    try {
      const { viewer, session, canvas } = await makeViewer();
      await viewer.load(IDML);
      expect(observers).toHaveLength(1);
      expect(observers[0]?.targets).toEqual([canvas]);

      setCanvasSize(canvas, 400, 300);
      observers[0]?.notify();
      expect(session.resizes.at(-1)).toEqual({
        width: 400,
        height: 300,
        dpr: 2,
      });

      viewer.dispose();
      expect(observers[0]?.connected).toBe(false);
    } finally {
      scope.ResizeObserver = original;
    }
  });
});

describe("device pixel ratio", () => {
  it("follows a change of window.devicePixelRatio", async () => {
    const scope = globalThis as { window?: unknown };
    const original = scope.window;
    const queries: Array<{
      media: string;
      listeners: Set<() => void>;
    }> = [];
    const fakeWindow = {
      devicePixelRatio: 1,
      matchMedia(media: string) {
        const query = { media, listeners: new Set<() => void>() };
        queries.push(query);
        return {
          addEventListener: (_: string, fn: () => void) =>
            query.listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) =>
            query.listeners.delete(fn),
        };
      },
    };
    scope.window = fakeWindow;
    try {
      const session = new FakeSession();
      const viewer = await createViewer({
        canvas: fakeCanvas(),
        session,
        schedule: syncSchedule,
      });
      await viewer.load(IDML);
      expect(session.presents.at(-1)?.dpr).toBe(1);
      expect(queries.map((q) => q.media)).toEqual(["(resolution: 1dppx)"]);

      // The window moves to a 2x screen: the query for 1x stops matching.
      fakeWindow.devicePixelRatio = 2;
      for (const fn of [...(queries[0]?.listeners ?? [])]) fn();

      expect(session.resizes.at(-1)).toEqual({
        width: 800,
        height: 600,
        dpr: 2,
      });
      expect(session.presents.at(-1)?.dpr).toBe(2);
      // The old query is released and the new ratio is watched.
      expect(queries[0]?.listeners.size).toBe(0);
      expect(queries.map((q) => q.media)).toEqual([
        "(resolution: 1dppx)",
        "(resolution: 2dppx)",
      ]);
      expect(queries[1]?.listeners.size).toBe(1);

      viewer.dispose();
      expect(queries[1]?.listeners.size).toBe(0);
    } finally {
      scope.window = original;
    }
  });

  it("a fixed devicePixelRatio is not watched", async () => {
    const scope = globalThis as { window?: unknown };
    const original = scope.window;
    let asked = 0;
    scope.window = {
      devicePixelRatio: 3,
      matchMedia() {
        asked += 1;
        return { addEventListener() {}, removeEventListener() {} };
      },
    };
    try {
      const { viewer, session } = await makeViewer(); // devicePixelRatio: 2
      await viewer.load(IDML);
      expect(asked).toBe(0);
      expect(session.presents.at(-1)?.dpr).toBe(2);
    } finally {
      scope.window = original;
    }
  });
});

describe("load and dispose", () => {
  it("a load that resolves after dispose touches nothing", async () => {
    const { viewer, session } = await makeViewer();
    let release!: () => void;
    const blob = {
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = () => resolve(new ArrayBuffer(2));
        }),
    } as unknown as Blob;
    const events: string[] = [];
    viewer.on("loaded", () => events.push("loaded"));
    viewer.on("error", () => events.push("error"));

    const pending = viewer.load(blob);
    viewer.dispose();
    release();
    await pending;

    expect(session.loads).toBe(0);
    expect(session.callsAfterFree).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a dispose while the canvas binds leaves the freed session alone", async () => {
    const session = new FakeSession();
    let release!: () => void;
    session.bindGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { viewer } = await makeViewer(session);

    const pending = viewer.load(IDML);
    await Promise.resolve(); // past the bytes, waiting for the bind
    expect(session.binds).toBe(1);
    viewer.dispose();
    release();
    await pending;

    expect(session.callsAfterFree).toEqual([]);
    expect(session.presents).toHaveLength(0);
  });

  it("a load after dispose is refused quietly", async () => {
    const { viewer, session } = await makeViewer();
    viewer.dispose();
    await viewer.load(IDML);
    expect(session.loads).toBe(0);
  });

  it("the later of two overlapping loads owns the viewer", async () => {
    const { viewer, session } = await makeViewer();
    let releaseFirst!: () => void;
    const slow = {
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseFirst = () => resolve(new ArrayBuffer(2));
        }),
    } as unknown as Blob;
    const loaded: number[] = [];
    viewer.on("loaded", (e) => loaded.push(e.pageCount));

    const first = viewer.load(slow);
    await viewer.load(IDML);
    releaseFirst();
    await first;

    expect(session.loads).toBe(1);
    expect(loaded).toEqual([3]);
  });

  it("overlapping loads bind the canvas once", async () => {
    const session = new FakeSession();
    let release!: () => void;
    session.bindGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { viewer } = await makeViewer(session);
    const loaded: number[] = [];
    viewer.on("loaded", (e) => loaded.push(e.pageCount));

    const first = viewer.load(IDML);
    const second = viewer.load(IDML);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(session.binds).toBe(1);
    expect(loaded).toEqual([3]);
  });
});

describe("page x origin", () => {
  /** A cover page, then a spread of two pages side by side. */
  function spreadLayout() {
    const layout = letterLayout(1);
    layout.pages.push(
      { index: 1, xPt: 0, yPt: 816, widthPt: 612, heightPt: 792 },
      { index: 2, xPt: 612, yPt: 816, widthPt: 612, heightPt: 792 },
    );
    return layout;
  }

  it("goToPage centres the right-hand page of a spread", async () => {
    const { viewer } = await makeViewer(new FakeSession(spreadLayout()));
    await viewer.load(IDML);
    viewer.setZoom(2);

    viewer.goToPage(2);

    // The right-hand page's centre (doc x 918) sits at the viewport centre.
    expect(viewer.scroll.x + 918 * viewer.zoom).toBeCloseTo(400, 6);
    expect(viewer.currentPage).toBe(2);
  });

  it("scrolling across a spread derives the page under the centre", async () => {
    const { viewer } = await makeViewer(new FakeSession(spreadLayout()));
    await viewer.load(IDML);
    viewer.setZoom(2);
    viewer.goToPage(1);
    expect(viewer.currentPage).toBe(1);

    viewer.scrollBy(-612 * viewer.zoom, 0);
    expect(viewer.currentPage).toBe(2);
  });
});

describe("session names", () => {
  it("accepts a session under the camelCase names", async () => {
    const fake = new FakeSession();
    const { viewer } = await makeViewer(
      adaptSession(fake) as unknown as FakeSession,
    );
    await viewer.load(IDML);
    expect(fake.loads).toBe(1);
    expect(viewer.pageCount).toBe(3);
  });

  it("registerFont reaches the session's register_font", async () => {
    const fake = new FakeSession();
    const { viewer } = await makeViewer(fake);
    viewer.registerFont("Inter", undefined, new Uint8Array(1));
    expect(fake.fonts).toEqual(["Inter"]);
  });
});
