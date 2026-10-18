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

// The gesture DSL's BROWSER backend: real input into the running editor.
//
// Document points become client px through the live camera — the one
// the canvas maps its pointer events with — and the viewport host's box:
// `client = host.left + doc · scale + tx`. Pages stack the way the
// canvas lays them out (one column, 24 pt apart: apps/canvas/src/ui/
// layout.ts), so `{ page: i, at }` resolves to the page's origin.
//
// Input: a mouse goes through Playwright's mouse and keyboard (the
// modifiers are real key presses, held across the samples that carry
// them). A PEN goes through CDP `Input.dispatchMouseEvent` with
// `pointerType: "pen"`, `force` (pressure) and tilt; TOUCH through CDP
// `Input.dispatchTouchEvent`. A pinch is ctrl + wheel, as a trackpad
// delivers it. `pointercancel` is dispatched on the viewport host (what
// a capture loss delivers).
//
// WAITING, never sleeping. `settle()` resolves when the editor is QUIET:
// the engine client has no request in flight over three consecutive
// animation frames, and a round trip through the worker (which answers
// in order) has come back, so everything the gesture sent has been
// applied. The worker posts no rendered-generation notification today
// (see this kit's README): a pixel assertion must therefore poll the
// render, as the op sandwich does; the model assertions this backend is
// built for need no render signal.
//
// Runner-agnostic: `BrowserPage` is the structural slice of a Playwright
// `Page` this uses; nothing here imports a runner.

import type { CursorSpec } from "@paged-media/plugin-api";
import {
  createGestureDsl,
  type DblclickTapeSample,
  type GestureBackend,
  type GestureDsl,
  type GesturePoint,
  type KeyTapeSample,
  type ModifierName,
  type PointerTapeSample,
  type ToolRef,
  type WheelTapeSample,
} from "@paged-media/plugin-sdk/gesture-kit";

/** The slice of a Playwright `Page` the backend drives. */
export interface BrowserPage {
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    down(options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }): Promise<void>;
    up(options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }): Promise<void>;
    dblclick(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  evaluate(fn: any, arg?: any): Promise<any>;
  context(): {
    newCDPSession(
      page: any,
    ): Promise<{ send(method: any, params?: any): Promise<any> }>;
  };
}

export interface BrowserBackendOptions {
  /** CSS selector of the element the canvas listens on. */
  host?: string;
  /** Gap between stacked pages, pt (the canvas's layoutPages default). */
  pageGapPt?: number;
  /** How long `settle()` and tool activation may take, ms. */
  timeoutMs?: number;
}

const KEY_OF: Record<ModifierName, string> = {
  shift: "Shift",
  alt: "Alt",
  cmd: "Meta",
  ctrl: "Control",
};
const CDP_BIT: Record<ModifierName, number> = {
  alt: 1,
  ctrl: 2,
  cmd: 4,
  shift: 8,
};

interface View {
  left: number;
  top: number;
  scale: number;
  tx: number;
  ty: number;
  pages: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

/** The browser backend over a Playwright page. */
export function browserBackend(
  page: BrowserPage,
  options: BrowserBackendOptions = {},
): GestureBackend {
  const hostSel = options.host ?? '[data-testid="viewport-canvas-host"]';
  const gap = options.pageGapPt ?? 24;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const held = new Set<ModifierName>();
  /** Modifiers a key chord pressed, released with its key. */
  const chordMods = new Map<string, ModifierName[]>();
  let cdp: { send(method: any, params?: any): Promise<any> } | null = null;
  let view: View | null = null;

  const readView = async (): Promise<View> =>
    page.evaluate(
      ({ sel, gapPt }: { sel: string; gapPt: number }) => {
        const host = document.querySelector(sel);
        if (!host) throw new Error(`browser backend: no viewport host ${sel}`);
        const r = host.getBoundingClientRect();
        const c = (globalThis as any).__canvas;
        const cam = c.client.camera.read();
        const handle = c.handle ?? {};
        const ids: string[] = handle.pageIds ?? [];
        const sizes: Array<[number, number]> = handle.pageSizesPt ?? [];
        let y = 0;
        const pages = ids.map((id, i) => {
          const [w, h] = sizes[i] ?? [0, 0];
          const p = { id, x: 0, y, w, h };
          y += h + gapPt;
          return p;
        });
        return {
          left: r.left,
          top: r.top,
          scale: cam.scale,
          tx: cam.tx,
          ty: cam.ty,
          pages,
        };
      },
      { sel: hostSel, gapPt: gap },
    );

  const current = async (): Promise<View> => (view ??= await readView());
  const invalidate = () => {
    view = null;
  };

  const toClient = async (
    pos: readonly [number, number],
  ): Promise<[number, number]> => {
    const v = await current();
    return [v.left + pos[0] * v.scale + v.tx, v.top + pos[1] * v.scale + v.ty];
  };

  /** Before a press: when the point is outside the middle of the viewport
   *  (off screen, or under the chrome along its edges), pan with a plain
   *  wheel — the editor's own pan, exact in screen px — so the point sits
   *  at 35 % / 35 % of the viewport and the drag that follows has room. */
  const ensureVisible = async (pos: readonly [number, number]) => {
    const v = await current();
    const box: { w: number; h: number } = await page.evaluate((sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }, hostSel);
    const [x, y] = await toClient(pos);
    const inside = (c: number, lo: number, len: number) =>
      c >= lo + len * 0.2 && c <= lo + len * 0.8;
    if (inside(x, v.left, box.w) && inside(y, v.top, box.h)) return;
    const dx = x - (v.left + box.w * 0.35);
    const dy = y - (v.top + box.h * 0.35);
    await page.mouse.move(v.left + box.w / 2, v.top + box.h / 2);
    await holdMods([]);
    await page.mouse.wheel(dx, dy);
    await page.evaluate(
      async ({ tx, ty }: { tx: number; ty: number }) => {
        const c = (globalThis as any).__canvas.client;
        for (let k = 0; k < 120; k++) {
          const cam = c.camera.read();
          if (cam.tx !== tx || cam.ty !== ty) return;
          await new Promise((r) => requestAnimationFrame(r));
        }
      },
      { tx: v.tx, ty: v.ty },
    );
    invalidate();
  };

  /** Hold exactly `mods` (key presses), as the next sample needs. */
  const holdMods = async (mods: readonly ModifierName[]) => {
    for (const m of [...held]) {
      if (!mods.includes(m)) {
        await page.keyboard.up(KEY_OF[m]);
        held.delete(m);
      }
    }
    for (const m of mods) {
      if (!held.has(m)) {
        await page.keyboard.down(KEY_OF[m]);
        held.add(m);
      }
    }
  };

  const session = async () =>
    (cdp ??= await page.context().newCDPSession(page));
  const cdpMods = (mods: readonly ModifierName[]) =>
    mods.reduce((n, m) => n | CDP_BIT[m], 0);

  const settle = async () => {
    await page.evaluate(
      async ({ deadlineMs }: { deadlineMs: number }) => {
        const c = (globalThis as any).__canvas?.client;
        if (!c) throw new Error("browser backend: no __canvas.client");
        const frame = () =>
          new Promise<void>((r) => requestAnimationFrame(() => r()));
        const pending = () =>
          (c.pending?.size ?? 0) + (c.bytesPending?.size ?? 0);
        const until = performance.now() + deadlineMs;
        let quiet = 0;
        while (quiet < 3) {
          await frame();
          quiet = pending() === 0 ? quiet + 1 : 0;
          if (performance.now() > until) {
            throw new Error(
              `browser backend: the editor did not settle (${pending()} request(s) in flight)`,
            );
          }
        }
        // The worker answers in order: this reply means every message the
        // gesture posted has been applied.
        await c.send({ kind: "requestDocumentMeta" });
      },
      { deadlineMs: timeoutMs },
    );
  };

  const backend: GestureBackend = {
    name: "browser",
    async tool(ref: ToolRef) {
      if (typeof ref !== "string") {
        throw new Error(
          "browser backend: mount a registered tool by id (a handler object cannot cross into the page)",
        );
      }
      const id: string = await page.evaluate(
        async ({ name, deadlineMs }: { name: string; deadlineMs: number }) => {
          const c = (globalThis as any).__canvas;
          const tools: Array<{ id: string; status?: string }> =
            c.registries.tools.list();
          const found =
            tools.find((t) => t.id === name) ??
            tools.find((t) => t.id.endsWith(`.tool.${name}`)) ??
            tools.find((t) => t.id.endsWith(`.${name}`));
          if (!found)
            throw new Error(
              `browser backend: no registered tool matches "${name}"`,
            );
          if (found.status === "planned")
            throw new Error(`browser backend: "${found.id}" is a planned stub`);
          await c.registries.commands.invoke(`paged.tool.activate.${found.id}`);
          const until = performance.now() + deadlineMs;
          const active = () =>
            Array.from(
              document.querySelectorAll('[data-tool][data-active="true"]'),
            ).some((el) => (el as HTMLElement).dataset.tool === found.id);
          while (!active()) {
            await new Promise((r) => requestAnimationFrame(r));
            if (performance.now() > until) {
              throw new Error(
                `browser backend: "${found.id}" did not become the active tool`,
              );
            }
          }
          return found.id;
        },
        { name: ref, deadlineMs: timeoutMs },
      );
      return id;
    },
    async resolve(point: GesturePoint) {
      if (Array.isArray(point)) return [point[0], point[1]];
      const p = point as {
        page: string | number;
        at: readonly [number, number];
      };
      const v = await current();
      const pg =
        typeof p.page === "number"
          ? v.pages[p.page]
          : v.pages.find((x) => x.id === p.page);
      if (!pg) throw new Error(`browser backend: no page ${String(p.page)}`);
      return [pg.x + p.at[0], pg.y + p.at[1]];
    },
    async pointer(s: PointerTapeSample) {
      if (s.type === "pointerdown") {
        invalidate();
        await ensureVisible(s.pos);
      }
      const [x, y] = await toClient(s.pos);
      if (s.type === "pointercancel") {
        await page.evaluate(
          ({ sel, id }: { sel: string; id: number }) => {
            document.querySelector(sel)?.dispatchEvent(
              new PointerEvent("pointercancel", {
                bubbles: true,
                pointerId: id,
              }),
            );
          },
          { sel: hostSel, id: s.pointerId },
        );
        await page.mouse.up();
        await holdMods([]);
        return;
      }
      if (s.device === "mouse") {
        await holdMods(s.mods);
        const button = s.button === 2 ? "right" : "left";
        if (s.type === "pointerdown") {
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
        } else if (s.type === "pointermove") {
          await page.mouse.move(x, y);
        } else {
          await page.mouse.move(x, y);
          await page.mouse.up({ button });
          // The gesture is over: let go of its modifiers. A held Cmd would
          // spring-load another tool for whatever comes next.
          await holdMods([]);
        }
        return;
      }
      const client = await session();
      const modifiers = cdpMods(s.mods);
      if (s.device === "pen") {
        await client.send("Input.dispatchMouseEvent", {
          type:
            s.type === "pointerdown"
              ? "mousePressed"
              : s.type === "pointerup"
                ? "mouseReleased"
                : "mouseMoved",
          x,
          y,
          button: s.type === "pointermove" && s.buttons === 0 ? "none" : "left",
          buttons: s.buttons,
          clickCount: s.type === "pointermove" ? 0 : 1,
          pointerType: "pen",
          force: s.pressure,
          tiltX: s.tiltX,
          tiltY: s.tiltY,
          modifiers,
        });
        return;
      }
      await client.send("Input.dispatchTouchEvent", {
        type:
          s.type === "pointerdown"
            ? "touchStart"
            : s.type === "pointerup"
              ? "touchEnd"
              : "touchMove",
        touchPoints:
          s.type === "pointerup"
            ? []
            : [{ x, y, force: s.pressure, id: s.pointerId }],
        modifiers,
      });
    },
    async key(s: KeyTapeSample) {
      const mods = s.mods.filter((m) => KEY_OF[m] !== s.key);
      if (s.type === "keydown") {
        // A chord: the modifiers the key brings are pressed for it and
        // let go with it; ones a drag already holds stay held.
        const added = mods.filter((m) => !held.has(m));
        chordMods.set(s.key, added);
        await holdMods([...held, ...added]);
        await page.keyboard.down(s.key);
      } else {
        await page.keyboard.up(s.key);
        const added = chordMods.get(s.key) ?? [];
        chordMods.delete(s.key);
        await holdMods([...held].filter((m) => !added.includes(m)));
      }
      invalidate();
    },
    async wheel(s: WheelTapeSample) {
      const [x, y] = await toClient(s.pos);
      await page.mouse.move(x, y);
      await holdMods(s.mods);
      await page.mouse.wheel(s.deltaX, s.deltaY);
      await holdMods([]);
      invalidate();
    },
    async dblclick(s: DblclickTapeSample) {
      invalidate();
      await ensureVisible(s.pos);
      const [x, y] = await toClient(s.pos);
      await holdMods(s.mods);
      await page.mouse.dblclick(x, y);
      await holdMods([]);
    },
    /** Zoom to `scale` with ctrl + wheel about the viewport centre — the
     *  editor's own zoom path (`zoomAt`, factor e^(−deltaY·0.005)). */
    async zoom(scale: number) {
      for (let i = 0; i < 4; i++) {
        const v = await readView();
        if (Math.abs(v.scale - scale) / scale < 0.002) break;
        const box: { w: number; h: number } = await page.evaluate(
          (sel: string) => {
            const r = document.querySelector(sel)!.getBoundingClientRect();
            return { w: r.width, h: r.height };
          },
          hostSel,
        );
        await page.mouse.move(v.left + box.w / 2, v.top + box.h / 2);
        await holdMods(["ctrl"]);
        await page.mouse.wheel(0, -Math.log(scale / v.scale) / 0.005);
        await holdMods([]);
        await page.evaluate(
          async ({ before }: { before: number }) => {
            const c = (globalThis as any).__canvas.client;
            for (let k = 0; k < 120 && c.camera.read().scale === before; k++) {
              await new Promise((r) => requestAnimationFrame(r));
            }
          },
          { before: v.scale },
        );
      }
      invalidate();
    },
    settle,
    async cursorAt(
      pos: [number, number],
    ): Promise<string | CursorSpec | undefined> {
      const [x, y] = await toClient(pos);
      await page.mouse.move(x, y);
      return page.evaluate(
        ({ px, py }: { px: number; py: number }) => {
          const el = document.elementFromPoint(px, py);
          return el ? getComputedStyle(el).cursor : undefined;
        },
        { px: x, py: y },
      );
    },
    async scale() {
      return (await readView()).scale;
    },
  };
  return backend;
}

/** The DSL over the browser backend. */
export function browserGestures(
  page: BrowserPage,
  options?: BrowserBackendOptions,
): GestureDsl {
  return createGestureDsl(browserBackend(page, options));
}

/** Resolve with the next commit the engine reports (a `mutationApplied`
 *  or `gestureCommitted`), or null when none lands before `run` has
 *  settled. Arms a recorder in the page before `run` and reads it after. */
export async function commitsDuring(
  page: BrowserPage,
  run: () => Promise<unknown>,
): Promise<Array<{ kind: string; pageIds?: string[]; createdId?: unknown }>> {
  await page.evaluate(() => {
    const g = globalThis as any;
    g.__gestureCommits?.unsub?.();
    const log: unknown[] = [];
    const unsub = g.__canvas.client.subscribe((m: any) => {
      if (m.kind === "mutationApplied" || m.kind === "gestureCommitted") {
        log.push({
          kind: m.kind,
          pageIds: m.payload?.pageIds,
          createdId: m.payload?.createdId ?? null,
        });
      }
    });
    g.__gestureCommits = { log, unsub };
  });
  await run();
  return page.evaluate(() => {
    const g = globalThis as any;
    const out = g.__gestureCommits?.log ?? [];
    g.__gestureCommits?.unsub?.();
    g.__gestureCommits = null;
    return out;
  });
}
