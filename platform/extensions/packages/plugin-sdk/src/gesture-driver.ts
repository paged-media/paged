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

// The GESTURE DSL: one way to write a gesture, in document points, for
// every layer that runs one.
//
//   const g = gestures(fake);                  // the unit backend
//   await g.tool("rectangle").drag({ from: [72, 72], to: [216, 144], mods: ["shift"] });
//   await g.click([100, 100]).key("Escape").wheel({ ctrl: true, deltaY: -120 });
//
// A BACKEND turns the DSL's samples into input:
//
//   · `unitBackend` (here): mounts the tool's `GestureHandler` the way the
//     editor's gesture spine does and calls it with `CanvasPointerEvent`s
//     resolved against a page layout and a zoom — against a fake editor
//     (`createFakeEditor`) or any other `PagedEditor`, the headless
//     engine's included (`createHeadlessHost(...).host.editor`);
//   · the browser backend (the editor's own test kit): real pointer
//     events through the running editor's camera.
//
// The DSL records every sample it sends, so any gesture written with it
// is also a TAPE (`g.tape()`, ./pointer-tape.ts) that replays through
// either backend.
//
// The chain is a thenable: each call queues its samples and returns the
// same DSL; `await` runs the queue. A failure rejects the await.

import type {
  CanvasPointerEvent,
  CursorSpec,
  GestureHandler,
  PagedEditor,
  ToolContribution,
} from "@paged-media/plugin-api";

import type { FakeEditor, FakePage } from "./fake-editor.js";
import {
  replayTape,
  type DblclickTapeSample,
  type KeyTapeSample,
  type ModifierName,
  type PointerDevice,
  type PointerTape,
  type PointerTapeSample,
  type ReplayOptions,
  type TapeReplayTarget,
  type TapeSample,
  type WheelTapeSample,
} from "./pointer-tape.js";

/** A point in DOCUMENT pt, or a point local to one page (by id or index). */
export type GesturePoint =
  | readonly [number, number]
  | { page: string | number; at: readonly [number, number] };

export interface GesturePointerOptions {
  mods?: readonly ModifierName[];
  /** 0 primary (default), 2 secondary. */
  button?: number;
  device?: PointerDevice;
  /** Pointer Events pressure; default 0.5 while pressed, 0 otherwise. */
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  pointerId?: number;
}

export interface GestureDragOptions extends GesturePointerOptions {
  from: GesturePoint;
  to: GesturePoint;
  /** Intermediate points the drag passes through, in order. */
  via?: readonly GesturePoint[];
  /** Move samples per segment (default 8). */
  steps?: number;
  /** Keys pressed during the drag: after move sample `at` (0-based,
   *  counted over the whole drag). */
  keys?: ReadonlyArray<{
    at: number;
    key: string;
    mods?: readonly ModifierName[];
  }>;
  /** Per-sample modifiers (INV-5 checks: flap Shift mid-drag). Wins
   *  over `mods` for the moves and the release. */
  modsAt?: (sample: number, total: number) => readonly ModifierName[];
  /** Per-sample pressure (pen strokes). */
  pressureAt?: (sample: number, total: number) => number;
  /** Release at `to` (default true). False leaves the button down, to
   *  cancel or inspect mid-drag. */
  release?: boolean;
}

export interface GestureWheelOptions {
  at?: GesturePoint;
  deltaX?: number;
  deltaY?: number;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  cmd?: boolean;
}

/** What a backend delivers. All positions are already document pt. */
export interface GestureBackend extends TapeReplayTarget {
  readonly name: string;
  /** Mount a tool; resolves to the id it mounted. */
  tool(id: ToolRef): Promise<string>;
  /** A DSL point → document pt. */
  resolve(point: GesturePoint): Promise<[number, number]>;
  /** The cursor the active tool shows at a point (a CSS cursor string,
   *  or the handler's `CursorSpec`), or undefined for the base cursor. */
  cursorAt(pos: [number, number]): Promise<string | CursorSpec | undefined>;
  /** The current camera scale (CSS px per pt). */
  scale(): Promise<number>;
}

/** A tool to mount: a registered id (or short name), a contribution, a
 *  handler, or a handler factory (a contribution's `gesture`). */
export type ToolRef =
  string | ToolContribution | GestureHandler | (() => GestureHandler);

export interface GestureDsl extends PromiseLike<void> {
  readonly backend: GestureBackend;
  /** Run the queue: a real Promise (for `expect(...).rejects`). */
  run(): Promise<void>;
  tool(id: ToolRef): GestureDsl;
  zoom(scale: number): GestureDsl;
  down(at: GesturePoint, options?: GesturePointerOptions): GestureDsl;
  move(to: GesturePoint, options?: GesturePointerOptions): GestureDsl;
  /** A move with no button held. */
  hover(at: GesturePoint, options?: GesturePointerOptions): GestureDsl;
  up(at?: GesturePoint, options?: GesturePointerOptions): GestureDsl;
  drag(options: GestureDragOptions): GestureDsl;
  click(at: GesturePoint, options?: GesturePointerOptions): GestureDsl;
  dblclick(
    at: GesturePoint,
    options?: { mods?: readonly ModifierName[] },
  ): GestureDsl;
  /** keydown + keyup. */
  key(key: string, options?: { mods?: readonly ModifierName[] }): GestureDsl;
  wheel(options: GestureWheelOptions): GestureDsl;
  /** Escape, mid-gesture: every handler's zero-mutation cancel. */
  cancel(): GestureDsl;
  /** The browser's pointercancel (capture loss): the host aborts. */
  pointerCancel(at?: GesturePoint): GestureDsl;
  /** Wait for the backend to go quiet (replies landed, chains ran). */
  settle(): GestureDsl;
  /** Run `fn` in the chain, between samples. */
  do(fn: () => unknown | Promise<unknown>): GestureDsl;
  /** The cursor at a point (runs the queue first). */
  cursorAt(at: GesturePoint): Promise<string | CursorSpec | undefined>;
  /** Everything sent so far, as a tape. */
  tape(name?: string): PointerTape;
  /** Replay a tape through this DSL's backend (recorded as well). */
  replay(tape: PointerTape, options?: ReplayOptions): GestureDsl;
}

const MOVE_MS = 16;
/** The tape's tool id for a tool mounted as an object, not an id: a
 *  replay cannot resolve it, so it keeps whatever tool is mounted. */
export const INLINE_TOOL = "inline:";
const PRESS_MS = 50;

/** Build the DSL over a backend. */
export function createGestureDsl(backend: GestureBackend): GestureDsl {
  let queue: Promise<void> = Promise.resolve();
  const samples: TapeSample[] = [];
  let t = 0;
  let zoom: number | undefined;
  let last: [number, number] = [0, 0];
  let pressed = false;
  let pointerDevice: PointerDevice = "mouse";

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task);
    return dsl;
  };

  const record = <S extends TapeSample>(s: S): S => {
    samples.push(s);
    return s;
  };

  const pointerSample = (
    type: PointerTapeSample["type"],
    pos: [number, number],
    o: GesturePointerOptions,
    mods: readonly ModifierName[],
    pressure?: number,
  ): PointerTapeSample => {
    const button = o.button ?? 0;
    const down = type === "pointerdown" || (type === "pointermove" && pressed);
    const device = o.device ?? pointerDevice;
    return {
      t,
      type,
      pos,
      button: type === "pointermove" ? -1 : button,
      buttons: down ? (button === 2 ? 2 : 1) : 0,
      mods: [...mods],
      device,
      pointerId: o.pointerId ?? 1,
      pressure: pressure ?? o.pressure ?? (down ? 0.5 : 0),
      tiltX: o.tiltX ?? 0,
      tiltY: o.tiltY ?? 0,
    };
  };

  const send = async (s: PointerTapeSample) => {
    record(s);
    last = s.pos;
    if (s.type === "pointerdown") pressed = true;
    if (s.type === "pointerup" || s.type === "pointercancel") pressed = false;
    await backend.pointer(s);
  };

  const lerp = (
    a: [number, number],
    b: [number, number],
    k: number,
  ): [number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

  const keyPress = async (key: string, mods: readonly ModifierName[]) => {
    for (const type of ["keydown", "keyup"] as const) {
      const s: KeyTapeSample = record({ t, type, key, mods: [...mods] });
      await backend.key(s);
    }
  };

  const dsl: GestureDsl = {
    backend,
    then(onfulfilled, onrejected) {
      return queue.then(() => undefined).then(onfulfilled, onrejected);
    },
    run() {
      return queue.then(() => undefined);
    },
    tool(id) {
      return enqueue(async () => {
        const mounted = await backend.tool(id);
        record({
          t,
          type: "tool",
          tool: typeof id === "string" ? mounted : `${INLINE_TOOL}${mounted}`,
        });
      });
    },
    zoom(scale) {
      return enqueue(async () => {
        if (!backend.zoom)
          throw new Error(`${backend.name} backend cannot set the zoom`);
        await backend.zoom(scale);
        zoom ??= scale;
        record({ t, type: "zoom", scale });
      });
    },
    down(at, o = {}) {
      return enqueue(async () => {
        pointerDevice = o.device ?? "mouse";
        t += PRESS_MS;
        await send(
          pointerSample(
            "pointerdown",
            await backend.resolve(at),
            o,
            o.mods ?? [],
          ),
        );
      });
    },
    move(to, o = {}) {
      return enqueue(async () => {
        t += MOVE_MS;
        await send(
          pointerSample(
            "pointermove",
            await backend.resolve(to),
            o,
            o.mods ?? [],
          ),
        );
      });
    },
    hover(at, o = {}) {
      return enqueue(async () => {
        t += MOVE_MS;
        const s = pointerSample(
          "pointermove",
          await backend.resolve(at),
          o,
          o.mods ?? [],
        );
        await send({ ...s, buttons: 0, pressure: o.pressure ?? 0 });
      });
    },
    up(at, o = {}) {
      return enqueue(async () => {
        t += MOVE_MS;
        const pos = at === undefined ? last : await backend.resolve(at);
        await send(
          pointerSample("pointerup", pos, o, o.mods ?? [], o.pressure ?? 0),
        );
      });
    },
    drag(o) {
      return enqueue(async () => {
        pointerDevice = o.device ?? "mouse";
        const points = [o.from, ...(o.via ?? []), o.to];
        const resolved: [number, number][] = [];
        for (const p of points) resolved.push(await backend.resolve(p));
        const steps = Math.max(1, o.steps ?? 8);
        const total = steps * (resolved.length - 1);
        const modsAt = (i: number) => o.modsAt?.(i, total) ?? o.mods ?? [];
        const pressureAt = (i: number) => o.pressureAt?.(i, total);
        t += PRESS_MS;
        await send(
          pointerSample(
            "pointerdown",
            resolved[0],
            o,
            modsAt(0),
            pressureAt(0),
          ),
        );
        let i = 0;
        for (let seg = 1; seg < resolved.length; seg++) {
          for (let k = 1; k <= steps; k++) {
            t += MOVE_MS;
            const pos = lerp(resolved[seg - 1], resolved[seg], k / steps);
            await send(
              pointerSample(
                "pointermove",
                pos,
                o,
                modsAt(i + 1),
                pressureAt(i + 1),
              ),
            );
            for (const key of o.keys ?? []) {
              if (key.at === i) await keyPress(key.key, key.mods ?? []);
            }
            i++;
          }
        }
        if (o.release ?? true) {
          t += MOVE_MS;
          await send(
            pointerSample(
              "pointerup",
              resolved[resolved.length - 1],
              o,
              modsAt(total),
              0,
            ),
          );
        }
      });
    },
    click(at, o = {}) {
      return enqueue(async () => {
        pointerDevice = o.device ?? "mouse";
        const pos = await backend.resolve(at);
        t += PRESS_MS;
        await send(pointerSample("pointerdown", pos, o, o.mods ?? []));
        t += PRESS_MS;
        await send(pointerSample("pointerup", pos, o, o.mods ?? [], 0));
      });
    },
    dblclick(at, o = {}) {
      return enqueue(async () => {
        t += PRESS_MS;
        const s: DblclickTapeSample = record({
          t,
          type: "dblclick",
          pos: await backend.resolve(at),
          mods: [...(o.mods ?? [])],
        });
        last = s.pos;
        await backend.dblclick(s);
      });
    },
    key(key, o = {}) {
      return enqueue(async () => {
        t += PRESS_MS;
        await keyPress(key, o.mods ?? []);
      });
    },
    wheel(o) {
      return enqueue(async () => {
        t += MOVE_MS;
        const mods: ModifierName[] = [];
        if (o.shift) mods.push("shift");
        if (o.alt) mods.push("alt");
        if (o.cmd) mods.push("cmd");
        if (o.ctrl) mods.push("ctrl");
        const s: WheelTapeSample = record({
          t,
          type: "wheel",
          pos: o.at === undefined ? last : await backend.resolve(o.at),
          deltaX: o.deltaX ?? 0,
          deltaY: o.deltaY ?? 0,
          mods,
        });
        await backend.wheel(s);
      });
    },
    cancel() {
      return dsl.key("Escape");
    },
    pointerCancel(at) {
      return enqueue(async () => {
        t += MOVE_MS;
        const pos = at === undefined ? last : await backend.resolve(at);
        await send(pointerSample("pointercancel", pos, {}, [], 0));
      });
    },
    settle() {
      return enqueue(() => backend.settle());
    },
    do(fn) {
      return enqueue(async () => {
        await fn();
      });
    },
    async cursorAt(at) {
      await queue;
      return backend.cursorAt(await backend.resolve(at));
    },
    tape(name) {
      return {
        version: 1,
        ...(name ? { name } : {}),
        coords: "doc",
        ...(zoom !== undefined ? { viewport: { zoom } } : {}),
        samples: samples.map((s) => ({ ...s })),
      };
    },
    replay(tape, options) {
      return enqueue(async () => {
        // Record what the replay sends, so a replayed tape re-records
        // identically (the round-trip the format promises).
        const recorder: TapeReplayTarget = {
          tool: async (id) => {
            if (id.startsWith(INLINE_TOOL)) {
              record({ t, type: "tool", tool: id });
              return;
            }
            const mounted = await backend.tool(id);
            record({ t, type: "tool", tool: mounted });
          },
          pointer: async (s) => {
            t = s.t;
            await send(s);
          },
          key: async (s) => {
            t = s.t;
            record(s);
            await backend.key(s);
          },
          wheel: async (s) => {
            t = s.t;
            record(s);
            await backend.wheel(s);
          },
          dblclick: async (s) => {
            t = s.t;
            record(s);
            last = s.pos;
            await backend.dblclick(s);
          },
          zoom: backend.zoom
            ? async (scale) => {
                await backend.zoom!(scale);
                record({ t, type: "zoom", scale });
              }
            : undefined,
          settle: () => backend.settle(),
        };
        await replayTape(tape, recorder, options);
      });
    },
  };
  return dsl;
}

// ------------------------------------------------------------- the unit backend

export interface UnitBackendOptions {
  /** The editor handed to `onActivate`. */
  editor: PagedEditor;
  /** The page layout, in document pt. Default: one Letter page at 0,0. */
  pages?: readonly FakePage[];
  /** The camera (its scale turns pt into the screen px of `maxDelta`). */
  camera?: () => { scale: number; tx: number; ty: number };
  setZoom?: (scale: number) => void;
  /** The tools `tool(id)` can mount (default: none; pass the registered
   *  contributions, or use a fake editor, whose registry is read). */
  tools?: () => readonly ToolContribution[];
  /** A camera model for `wheel` (the unit backend has no viewport). */
  wheel?: (sample: WheelTapeSample) => void;
  /** How to wait for in-flight work (default: a few idle macrotasks). */
  settle?: () => Promise<void>;
}

const LETTER_PAGE: FakePage = {
  id: "page-1",
  origin: [0, 0],
  size: [612, 792],
};

/** A plain keyboard event: what the shell's key routing hands a handler. */
export function keyboardEventLike(
  key: string,
  mods: readonly ModifierName[] = [],
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  let prevented = false;
  return {
    type,
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    shiftKey: mods.includes("shift"),
    altKey: mods.includes("alt"),
    metaKey: mods.includes("cmd"),
    ctrlKey: mods.includes("ctrl"),
    repeat: false,
    isComposing: false,
    target: null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  } as unknown as KeyboardEvent;
}

function isFakeEditor(v: unknown): v is FakeEditor {
  return Boolean(
    v &&
    typeof v === "object" &&
    "editor" in v &&
    "events" in v &&
    "settle" in v,
  );
}

/** Resolve a short tool name: the exact id, else an id ending in
 *  `.tool.<name>`, else one ending in `.<name>`. */
export function resolveToolId(
  tools: readonly ToolContribution[],
  name: string,
): ToolContribution | undefined {
  return (
    tools.find((t) => t.id === name) ??
    tools.find((t) => t.id.endsWith(`.tool.${name}`)) ??
    tools.find((t) => t.id.endsWith(`.${name}`))
  );
}

/**
 * The unit backend: drives a `GestureHandler` directly, as the editor's
 * gesture spine and canvas do — the outgoing handler is deactivated
 * ("switch") before the next mounts; a pointer event is resolved to the
 * page under it, `maxDelta` is the largest screen-px distance from the
 * press (click-vs-drag, as the canvas measures it); hover moves carry
 * `maxDelta` 0; `pointercancel` reaches the handler as Escape (the
 * canvas's abort); `dblclick` is two clicks (a handler has no
 * double-click hook). Keys go to `onKey` as plain keyboard events.
 */
export function unitBackend(
  target: FakeEditor | UnitBackendOptions,
): GestureBackend {
  const o: UnitBackendOptions = isFakeEditor(target)
    ? {
        editor: target.editor,
        pages: target.pages,
        camera: target.camera,
        setZoom: target.setZoom,
        tools: target.tools,
        settle: target.settle,
      }
    : target;
  const pages = o.pages ?? [LETTER_PAGE];
  const scale = () => {
    const s = o.camera?.().scale ?? o.editor.camera.camera.scale;
    return s > 0 ? s : 1;
  };
  let handler: GestureHandler | null = null;
  let start: [number, number] | null = null;
  let maxDelta = 0;

  const pageAt = (pos: readonly [number, number]): FakePage | null =>
    pages.find(
      (p) =>
        pos[0] >= p.origin[0] &&
        pos[0] <= p.origin[0] + p.size[0] &&
        pos[1] >= p.origin[1] &&
        pos[1] <= p.origin[1] + p.size[1],
    ) ?? null;

  const eventOf = (
    pos: [number, number],
    mods: readonly ModifierName[],
    s: Pick<
      PointerTapeSample,
      "button" | "pressure" | "tiltX" | "tiltY" | "device"
    >,
    delta: number,
  ): CanvasPointerEvent => {
    const page = pageAt(pos);
    return {
      pageId: page?.id ?? null,
      pagePoint: page
        ? [pos[0] - page.origin[0], pos[1] - page.origin[1]]
        : null,
      docPoint: [pos[0], pos[1]],
      modifiers: {
        shift: mods.includes("shift"),
        alt: mods.includes("alt"),
        cmd: mods.includes("cmd"),
        ctrl: mods.includes("ctrl"),
      },
      maxDelta: delta,
      button: s.button < 0 ? 0 : s.button,
      target: null,
      pressure: s.pressure,
      tiltX: s.tiltX,
      tiltY: s.tiltY,
      pointerType: s.device,
    };
  };

  const settle =
    o.settle ??
    (async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    });

  const active = (): GestureHandler => {
    if (!handler)
      throw new Error("unit backend: no tool mounted; call tool(id) first");
    return handler;
  };

  const backend: GestureBackend = {
    name: "unit",
    async tool(id) {
      let next: GestureHandler;
      let mountedId: string;
      if (typeof id === "string") {
        const c = resolveToolId(o.tools?.() ?? [], id);
        if (!c)
          throw new Error(`unit backend: no registered tool matches "${id}"`);
        if (!c.gesture) {
          throw new Error(
            `unit backend: tool "${c.id}" has no gesture handler; the host canvas routes it (use the browser backend)`,
          );
        }
        next = c.gesture();
        mountedId = c.id;
      } else if (typeof id === "function") {
        next = id();
        mountedId = id.name || "handler";
      } else if ("onPointerDown" in id) {
        next = id;
        mountedId = "handler";
      } else {
        if (!id.gesture)
          throw new Error(
            `unit backend: tool "${id.id}" has no gesture handler`,
          );
        next = id.gesture();
        mountedId = id.id;
      }
      handler?.onDeactivate("switch");
      handler = next;
      handler.onActivate(o.editor);
      return mountedId;
    },
    async resolve(point) {
      if (Array.isArray(point)) return [point[0], point[1]];
      const p = point as {
        page: string | number;
        at: readonly [number, number];
      };
      const page =
        typeof p.page === "number"
          ? pages[p.page]
          : pages.find((x) => x.id === p.page);
      if (!page) throw new Error(`unit backend: no page ${String(p.page)}`);
      return [page.origin[0] + p.at[0], page.origin[1] + p.at[1]];
    },
    async pointer(s) {
      const h = active();
      const k = scale();
      if (s.type === "pointerdown") {
        start = s.pos;
        maxDelta = 0;
        h.onPointerDown(eventOf(s.pos, s.mods, s, 0));
        return;
      }
      if (s.type === "pointercancel") {
        start = null;
        maxDelta = 0;
        h.onKey?.(keyboardEventLike("Escape"));
        return;
      }
      if (start) {
        const d = Math.hypot(
          (s.pos[0] - start[0]) * k,
          (s.pos[1] - start[1]) * k,
        );
        if (d > maxDelta) maxDelta = d;
      }
      if (s.type === "pointermove") {
        h.onPointerMove(
          eventOf(s.pos, s.mods, s, start && s.buttons !== 0 ? maxDelta : 0),
        );
        return;
      }
      h.onPointerUp(eventOf(s.pos, s.mods, s, maxDelta));
      start = null;
    },
    async key(s) {
      if (s.type === "keydown")
        handler?.onKey?.(keyboardEventLike(s.key, s.mods, "keydown"));
    },
    async wheel(s) {
      if (!o.wheel) {
        throw new Error(
          "unit backend: no camera model for wheel(); pass `wheel` or use the browser backend",
        );
      }
      o.wheel(s);
    },
    async dblclick(s) {
      for (let i = 0; i < 2; i++) {
        const base = {
          button: 0,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          device: "mouse" as const,
        };
        await backend.pointer({
          ...base,
          t: s.t,
          type: "pointerdown",
          pos: s.pos,
          buttons: 1,
          mods: s.mods,
          pointerId: 1,
        });
        await backend.pointer({
          ...base,
          t: s.t,
          type: "pointerup",
          pos: s.pos,
          buttons: 0,
          mods: s.mods,
          pointerId: 1,
          pressure: 0,
        });
      }
    },
    zoom: o.setZoom
      ? async (z) => {
          o.setZoom!(z);
        }
      : undefined,
    async settle() {
      await settle();
    },
    async cursorAt(pos) {
      return handler?.cursorAt?.(
        eventOf(
          pos,
          [],
          { button: 0, pressure: 0, tiltX: 0, tiltY: 0, device: "mouse" },
          0,
        ),
      );
    },
    async scale() {
      return scale();
    },
  };
  return backend;
}

/** The DSL over the unit backend: `gestures(fake)` or
 *  `gestures({ editor, pages, tools })`. */
export function gestures(target: FakeEditor | UnitBackendOptions): GestureDsl {
  return createGestureDsl(unitBackend(target));
}
