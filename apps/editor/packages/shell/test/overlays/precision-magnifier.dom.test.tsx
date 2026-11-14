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

// The precision magnifier's images (paged.draw ADR 370). The loupe draws
// the shot React has committed; until a newer shot is committed and drawn,
// the draws of earlier commits (a pointer move's, or a commit whose effects
// run late under load) still use the old image. The magnifier used to close
// that image the moment the next one was MADE, so a draw in between drew a
// closed ImageBitmap — which throws in a browser — and the loupe crashed
// under parallel load. Here the pointer is hammered between each snapshot's
// arrival and its commit: no image is closed before a newer one was drawn,
// no closed image is drawn, and none is left open but the one on screen.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import type { CanvasClient, PageId } from "@paged-media/client";

import { PrecisionMagnifier } from "../../src/overlays/precision-magnifier";
import { MAGNIFIER_KEY } from "../../src/overlays/precision-magnifier-geometry";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import { CANVAS_POINTER } from "../../src/state/canvas-pointer";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import { ToolProvider, useTool } from "../../src/state/tool-context";
import type { ToolId } from "../../src/registries/tool";

const PAGE = "p1" as PageId;

/** An ImageBitmap that knows whether it was closed (a closed one has no
 *  size, as in a browser). */
class FakeBitmap {
  static all: FakeBitmap[] = [];
  /** The newest image drawn so far (its index in `all`). */
  static newestDrawn = -1;
  /** Closes of an image no newer image had replaced on screen yet. */
  static closedEarly = 0;
  closed = false;
  width: number;
  height: number;
  readonly seq: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.seq = FakeBitmap.all.length;
    FakeBitmap.all.push(this);
  }
  close() {
    if (FakeBitmap.newestDrawn <= this.seq) FakeBitmap.closedEarly++;
    this.closed = true;
    this.width = 0;
    this.height = 0;
  }
}

let drewClosed = 0;
let drewOpen = 0;

/** The 2D context the loupe draws into: it counts the images drawn and
 *  every closed one among them. */
function fakeContext(): Partial<CanvasRenderingContext2D> {
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    stroke: noop,
    drawImage: ((image: FakeBitmap) => {
      if (image.closed) drewClosed++;
      else drewOpen++;
      FakeBitmap.newestDrawn = Math.max(FakeBitmap.newestDrawn, image.seq);
    }) as never,
  };
}

const saved: Record<string, unknown> = {};
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  FakeBitmap.all = [];
  FakeBitmap.newestDrawn = -1;
  FakeBitmap.closedEarly = 0;
  drewClosed = 0;
  drewOpen = 0;
  for (const k of [
    "createImageBitmap",
    "ImageData",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    saved[k] = g[k];
  g.createImageBitmap = async (data: { width: number; height: number }) =>
    new FakeBitmap(data.width, data.height);
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  saved.getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return fakeContext();
  } as never;
  // The race lives between a sync pointer render and a pending default
  // update: React schedules both itself here (no act around the hammer).
  g.IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (k === "getContext") HTMLCanvasElement.prototype.getContext = v as never;
    else g[k] = v;
  }
});

/** A client whose snapshots arrive when the test says so. */
function fakeClient() {
  const pending: Array<(px: number) => void> = [];
  const client = {
    subscribe: () => () => {},
    requestSnapshot(
      _page: PageId,
      px: number,
      _dpi: number | undefined,
      opts: { clip: { x: number; y: number; width: number; height: number } },
    ) {
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            widthPx: px,
            heightPx: px,
            rgba: new Uint8Array(px * px * 4),
            region: opts.clip,
          }),
        );
      });
    },
  };
  return {
    client: client as unknown as CanvasClient,
    /** Answer every request in flight. */
    answer() {
      for (const r of pending.splice(0)) r(0);
    },
    inFlight: () => pending.length,
  };
}

function PenInHand() {
  const tool = useTool();
  useEffect(() => {
    tool.setBaseTool("paged.tool.pen" as ToolId);
  }, [tool]);
  return null;
}

function mount(scope: EditorScope) {
  const fake = fakeClient();
  const view = render(
    <EditorScopeProvider scope={scope}>
      <CanvasClientProvider client={fake.client}>
        <ToolProvider>
          <PenInHand />
          <PrecisionMagnifier
            camera={{ scale: 1, tx: 0, ty: 0 }}
            width={800}
            height={600}
          />
        </ToolProvider>
      </CanvasClientProvider>
    </EditorScopeProvider>,
  );
  return { ...fake, view };
}

/** Microtasks only: promise callbacks and React's sync renders run, its
 *  default-priority work (a pending `setShot`) does not. */
async function microtasks(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** A macrotask: React commits what is pending. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the precision magnifier's images", () => {
  test("pointer moves hammered between a snapshot's arrival and its commit never draw a closed image", async () => {
    const scope = createEditorScope();
    const pointer = scope.get(CANVAS_POINTER);
    const { answer, inFlight, view } = mount(scope);
    const point = (i: number) =>
      pointer.set({
        pageId: PAGE,
        pagePoint: [100 + (i % 37) * 0.5, 120 + (i % 23) * 0.5],
        docPoint: [100 + (i % 37) * 0.5, 120 + (i % 23) * 0.5],
      });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: MAGNIFIER_KEY }),
      );
      point(0);
      await tick();
    });
    expect(view.container.querySelector("[data-precision-magnifier]")).not.toBe(
      null,
    );

    for (let i = 1; i <= 200; i++) {
      // A snapshot arrives: its image is made and its shot is pending.
      answer();
      await microtasks();
      // The pointer moves before React commits that shot (a sync render
      // that draws the shot it has), then again.
      point(i * 2);
      await microtasks();
      point(i * 2 + 1);
      await microtasks();
      // Now and then React catches up.
      if (i % 7 === 0) await tick();
    }
    // Let the last request arrive and everything commit.
    for (let k = 0; k < 10 && (inFlight() > 0 || k < 3); k++) {
      answer();
      await tick();
    }

    expect(drewClosed).toBe(0);
    expect(drewOpen).toBeGreaterThan(50);
    // Every image was closed after a newer one had been drawn in its place.
    expect(FakeBitmap.all.length).toBeGreaterThan(50);
    expect(FakeBitmap.closedEarly).toBe(0);
    // Only the image on screen is still open.
    expect(FakeBitmap.all.filter((b) => !b.closed)).toHaveLength(1);

    // The loupe lets go of it with the key.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: MAGNIFIER_KEY }));
      await tick();
    });
    expect(view.container.querySelector("[data-precision-magnifier]")).toBe(
      null,
    );
    expect(FakeBitmap.all.every((b) => b.closed)).toBe(true);
  });
});
