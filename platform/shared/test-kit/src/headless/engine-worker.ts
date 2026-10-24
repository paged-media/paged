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

// The render worker, in process: a `Worker`-shaped object the editor's REAL
// `CanvasClient` drives through its `workerFactory` option, so the client's
// whole request/reply machinery (seq matching, the binary load side-channel,
// the v66 binary doors, the script host-object rounds, edit tracking, the
// font-registry ledger) runs unchanged under `bun test`, with no browser.
//
// What it mirrors from apps/canvas/src/worker/worker.ts, message for message:
//   - `channel` envelopes go to `CanvasWorker.handleMessage`, except
//     `requestMeasureText` (the engine shaper) and the editor-local
//     `requestMeasureTextBatch`; a `commitGesture` drains the gesture SAB
//     first, as the worker does;
//   - `loadDocumentBinary` goes to `loadDocumentDirect` and answers
//     `loadDocumentBinaryReply`;
//   - the `direct` binary doors (scene images, parts, `mutateWithBytes`),
//     answering byte reads on `directBytesReply`;
//   - the Tier-3 resolver posts `resolutionDone` after a load, and once
//     after a burst of edits settles (the worker debounces it by 300 ms;
//     here a burst is "until the queue is empty");
//   - messages are processed strictly in order, one at a time, and a
//     dispatch that throws answers that request's seq with a
//     `dispatchError` warning instead of stranding it.
//
// Where it deliberately differs: a load whose dispatch throws is answered
// with `loadFailed` (the worker answers a `dispatchError` with no seq, so
// the client's load never settles), and after a trap (a Rust panic) every
// request is refused at once (`poisoned`): a test fails with the panic's
// message instead of hanging on a reply that never comes.
//
// What it does NOT do, by design: paint. `attachCanvas` / `resizeCanvas`
// are accepted and ignored, `renderPageVelloPng` answers `null`, and the
// worker's own journal ring is empty. The camera SAB is kept but never read.

import type { EngineCanvasWorker } from "./engine.ts";

type Listener = (event: { data: unknown }) => void;

/** One pending pointer update read off the gesture SAB (the client's
 *  `GestureBuffer.drainLatest()` record). */
export interface GestureRecord {
  handle: bigint;
  dx: number;
  dy: number;
  modifiers: { shift: boolean; alt: boolean; disableSnap: boolean };
}

export interface EngineWorkerOptions {
  /**
   * Read the gesture SAB the client hands over (`gestureSab`). The editor's
   * harness passes `(b) => new GestureBuffer(b)` from `@paged-media/client`,
   * so the layout has one definition. Without it SAB pointer updates are
   * ignored (the typed `updateGesture` channel message still works).
   */
  gestureReader?: (buffer: SharedArrayBuffer | ArrayBuffer) => {
    drainLatest(): GestureRecord | null;
  };
  /** Post the resolver's `resolutionDone` (default true). */
  resolution?: boolean;
}

/** What the main side posted, in order: the side-channel kind, and for a
 *  `channel` envelope its message kind. */
export interface PostedMessage {
  kind: string;
  channel?: string;
}

export interface EngineWorker {
  postMessage(data: unknown, transfer?: unknown): void;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  terminate(): void;
  /** The engine behind it. */
  readonly engine: EngineCanvasWorker;
  /** Resolves once every message posted so far has been answered. */
  idle(): Promise<void>;
  /** Every message the main side posted. */
  readonly posted: readonly PostedMessage[];
  /** Whether `terminate()` ran (the engine is freed then). */
  readonly terminated: boolean;
  /**
   * The first trap (a Rust panic: `unreachable`, or the borrow a panic left
   * held) the engine raised, or null. A trapped wasm instance is unusable:
   * from then on every request is answered with a refusal at once, so a
   * test fails with this message instead of waiting for a reply that never
   * comes.
   */
  readonly poisoned: string | null;
  /** Errors the Tier-3 resolver threw (the worker logs and drops them). */
  readonly resolverErrors: readonly string[];
}

type Incoming = { kind: string; [key: string]: unknown };

const MEASURE_ZERO = { advance: 0, ascender: 0, descender: 0 };

export function createEngineWorker(
  engine: EngineCanvasWorker,
  options: EngineWorkerOptions = {},
): EngineWorker {
  const protocol = engine.protocolVersion;
  const listeners = new Map<string, Set<Listener>>();
  const queue: Incoming[] = [];
  const posted: PostedMessage[] = [];
  const idleWaiters: Array<() => void> = [];
  let pumping = false;
  let terminated = false;
  let resolutionPending = false;
  let poisoned: string | null = null;
  const resolverErrors: string[] = [];
  const isTrap = (err: unknown) =>
    (typeof WebAssembly !== "undefined" &&
      err instanceof WebAssembly.RuntimeError) ||
    /unreachable|recursive use of an object/.test(String(err));
  let gesture: { drainLatest(): GestureRecord | null } | null = null;
  const wantResolution = options.resolution ?? true;

  const emit = (type: string, data: unknown) => {
    const set = listeners.get(type);
    if (!set || terminated) return;
    // A real worker's reply arrives as a later task; never re-enter the
    // caller synchronously.
    queueMicrotask(() => {
      if (terminated) return;
      for (const l of [...set]) l({ data });
    });
  };
  const postBack = (msg: unknown) => emit("message", msg);
  const warning = (seq: number | null, kind: string, details: string) =>
    postBack({ seq, protocol, kind: "warning", payload: { kind, details } });

  const postResolution = () => {
    resolutionPending = false;
    if (!wantResolution) return;
    let json: string | undefined;
    try {
      json = engine.runResolveJson();
    } catch (err) {
      resolverErrors.push(String(err));
      if (isTrap(err)) poisoned ??= `runResolveJson: ${String(err)}`;
      return;
    }
    if (!json) return;
    try {
      postBack({
        seq: null,
        protocol,
        kind: "resolutionDone",
        payload: JSON.parse(json),
      });
    } catch {
      /* the worker logs and drops an unparsable table */
    }
  };

  /** The worker's `applyReplyEffects`, minus the renderer. */
  const effects = (reply: { kind?: string }) => {
    switch (reply.kind) {
      case "documentLoaded":
        postResolution();
        return;
      case "mutationApplied":
      case "undoApplied":
      case "redoApplied":
      case "scriptResult":
      case "gestureCommitted":
      case "fontRegistered":
      case "fontRegistryCleared":
        resolutionPending = true;
        return;
    }
  };

  const settleJson = (json: string) => {
    if (!json) return;
    const reply = JSON.parse(json) as { kind?: string };
    postBack(reply);
    effects(reply);
  };

  const drainGesture = () => {
    const record = gesture?.drainLatest();
    if (!record || !engine.updateGestureRaw) return;
    let mods = 0;
    if (record.modifiers.shift) mods |= 0b001;
    if (record.modifiers.alt) mods |= 0b010;
    if (record.modifiers.disableSnap) mods |= 0b100;
    const out = engine.updateGestureRaw(
      Number(record.handle & 0xffff_ffffn),
      Number((record.handle >> 32n) & 0xffff_ffffn),
      record.dx,
      record.dy,
      mods,
    );
    if (!out) return;
    try {
      const { snapLines } = JSON.parse(out) as { snapLines: unknown[] };
      postBack({
        seq: null,
        protocol,
        kind: "gestureSnapLines",
        payload: { snapLines },
      });
    } catch {
      /* the worker warns and drops it */
    }
  };

  const direct = (m: Incoming) => {
    const seq = m["seq"] as number;
    const missing = () =>
      warning(
        seq,
        "dispatchError",
        `direct ${String(m["op"])}: this canvas-wasm has no binary door (protocol < 66)`,
      );
    const caller = (m["caller"] as string | null | undefined) ?? undefined;
    switch (m["op"]) {
      case "submitSceneImage": {
        if (!engine.submitSceneImageDirect) return missing();
        const [x, y, w, h] = m["dest"] as [number, number, number, number];
        return settleJson(
          engine.submitSceneImageDirect(
            seq,
            m["elementId"] as string,
            caller,
            m["rgba"] as Uint8Array,
            m["width"] as number,
            m["height"] as number,
            x,
            y,
            w,
            h,
          ),
        );
      }
      case "submitSceneImageTiles": {
        if (!engine.submitSceneImageTilesDirect) return missing();
        const tiles = m["tiles"] as Array<{
          x: number;
          y: number;
          width: number;
          height: number;
          rgba: Uint8Array;
        }>;
        const rects = new Uint32Array(tiles.length * 4);
        let total = 0;
        tiles.forEach((t, i) => {
          rects.set([t.x, t.y, t.width, t.height], i * 4);
          total += t.rgba.byteLength;
        });
        const rgba = new Uint8Array(total);
        let at = 0;
        for (const t of tiles) {
          rgba.set(t.rgba, at);
          at += t.rgba.byteLength;
        }
        return settleJson(
          engine.submitSceneImageTilesDirect(
            seq,
            m["elementId"] as string,
            caller,
            rects,
            rgba,
          ),
        );
      }
      case "writePagedPart":
        if (!engine.writePagedPartDirect) return missing();
        return settleJson(
          engine.writePagedPartDirect(
            seq,
            m["path"] as string,
            caller,
            m["bytes"] as Uint8Array,
          ),
        );
      case "mutateWithBytes":
        if (!engine.mutateWithBytesDirect) return missing();
        return settleJson(
          engine.mutateWithBytesDirect(
            seq,
            m["mutationJson"] as string,
            m["bytes"] as Uint8Array,
          ),
        );
      case "amendWithBytes":
        if (!engine.amendWithBytesDirect) return missing();
        return settleJson(
          engine.amendWithBytesDirect(
            seq,
            m["appliedSeq"] as number,
            m["mutationJson"] as string,
            m["bytes"] as Uint8Array,
          ),
        );
      case "readPagedPart":
        if (!engine.readPagedPartDirect) return missing();
        return postBack({
          kind: "directBytesReply",
          seq,
          bytes: engine.readPagedPartDirect(m["path"] as string) ?? null,
        });
      case "placedAssetBytes":
        if (!engine.placedAssetBytesDirect) return missing();
        return postBack({
          kind: "directBytesReply",
          seq,
          asset:
            engine.placedAssetBytesDirect(m["elementId"] as string) ?? null,
        });
    }
    return missing();
  };

  const dispatch = (m: Incoming) => {
    switch (m.kind) {
      case "cameraSab":
        return;
      case "gestureSab":
        gesture = options.gestureReader
          ? options.gestureReader(
              m["buffer"] as SharedArrayBuffer | ArrayBuffer,
            )
          : null;
        return;
      case "attachCanvas":
      case "resizeCanvas":
        return;
      case "journalDrain":
        return postBack({
          kind: "journalDrainReply",
          seq: m["seq"],
          entries: [],
          ledger: {
            evicted: 0,
            collapsed: 0,
            rejectedData: 0,
            sabGestureUpdates: 0,
            sabCameraWrites: 0,
            engineTracing: { debug: 0, info: 0, warn: 0, error: 0 },
          },
          epochWallMs: 0,
        });
      case "renderPageVelloPng":
        return postBack({
          kind: "velloPngReply",
          seq: m["seq"],
          pngBytes: null,
        });
      case "direct":
        return direct(m);
      case "loadDocumentBinary": {
        const seq = m["seq"] as number;
        const replyJson = engine.loadDocumentDirect(
          seq,
          m["bytes"] as Uint8Array,
          (m["font"] as Uint8Array | null) ?? undefined,
          (m["cmykIccProfile"] as Uint8Array | null) ?? undefined,
        );
        postBack({ kind: "loadDocumentBinaryReply", seq, replyJson });
        try {
          effects(JSON.parse(replyJson) as { kind?: string });
        } catch {
          /* the client reports a malformed reply */
        }
        return;
      }
      case "channel":
        break;
      default:
        return;
    }
    const msg = m["msg"] as {
      seq: number;
      kind: string;
      payload?: Record<string, unknown>;
    };
    drainGesture();
    if (msg.kind === "requestMeasureText") {
      const p = msg.payload as {
        family: string;
        style?: string | null;
        text: string;
        sizePt: number;
      };
      const metrics = engine.measureText?.(
        p.family,
        p.style ?? null,
        p.text,
        p.sizePt,
      );
      return postBack({
        seq: msg.seq,
        protocol,
        kind: "measureTextResult",
        payload: metrics ?? MEASURE_ZERO,
      });
    }
    if (msg.kind === "requestMeasureTextBatch") {
      const p = msg.payload as {
        family: string;
        style?: string | null;
        texts: string[];
        sizePt: number;
      };
      const metrics = p.texts.map((text) => {
        const r = engine.measureText?.(
          p.family,
          p.style ?? null,
          text,
          p.sizePt,
        );
        return r
          ? { advance: r.advance, ascender: r.ascender, descender: r.descender }
          : MEASURE_ZERO;
      });
      return postBack({
        seq: msg.seq,
        protocol,
        kind: "measureTextBatchResult",
        payload: { metrics },
      });
    }
    settleJson(engine.handleMessage(JSON.stringify(msg)));
  };

  const seqOf = (m: Incoming): number | null => {
    if (m.kind === "channel")
      return (m["msg"] as { seq?: number } | undefined)?.seq ?? null;
    if (m.kind === "direct") return (m["seq"] as number | undefined) ?? null;
    return null;
  };

  /** Answer a request at once with a refusal (a poisoned engine, or a
   *  load whose dispatch threw: the worker would strand that caller, a test
   *  must not hang on it). */
  const refuse = (m: Incoming, details: string) => {
    if (m.kind === "loadDocumentBinary") {
      const seq = m["seq"] as number;
      postBack({
        kind: "loadDocumentBinaryReply",
        seq,
        replyJson: JSON.stringify({
          seq,
          protocol,
          kind: "loadFailed",
          payload: { error: { kind: "parse", message: details } },
        }),
      });
      return;
    }
    if (m.kind === "journalDrain" || m.kind === "renderPageVelloPng")
      return dispatch(m);
    warning(seqOf(m), "dispatchError", details);
  };

  const pump = () => {
    if (pumping) return;
    pumping = true;
    queueMicrotask(() => {
      try {
        while (queue.length > 0 && !terminated) {
          const m = queue.shift()!;
          if (poisoned) {
            refuse(m, `${m.kind}: the engine trapped earlier (${poisoned})`);
            continue;
          }
          try {
            dispatch(m);
          } catch (err) {
            if (isTrap(err)) poisoned ??= `${m.kind}: ${String(err)}`;
            refuse(m, `${m.kind}: ${String(err)}`);
          }
        }
        if (resolutionPending && !terminated) postResolution();
      } finally {
        pumping = false;
        if (queue.length > 0) pump();
        else for (const w of idleWaiters.splice(0)) queueMicrotask(() => w());
      }
    });
  };

  return {
    engine,
    posted,
    get terminated() {
      return terminated;
    },
    get poisoned() {
      return poisoned;
    },
    resolverErrors,
    postMessage(data) {
      if (terminated) return;
      const m = data as Incoming;
      posted.push(
        m.kind === "channel"
          ? { kind: m.kind, channel: (m["msg"] as { kind: string }).kind }
          : { kind: m.kind },
      );
      queue.push(m);
      pump();
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      queue.length = 0;
      listeners.clear();
      try {
        engine.free();
      } catch {
        /* already freed */
      }
      for (const w of idleWaiters.splice(0)) w();
    },
    idle() {
      if (!pumping && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
