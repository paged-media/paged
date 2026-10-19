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

// The panel lane's ENGINE: the real engine wasm, booted headless in this
// process (plugin-sdk's `loadHeadlessEngine`, the same `CanvasWorker`
// the editor's worker drives), behind an object shaped like the Worker
// the editor's `CanvasClient` talks to.
//
// The editor's client is NOT faked: panels get the real `CanvasClient`,
// constructed with `workerFactory: () => engineWorker`, so a panel's
// request goes through the client's real seq matching, edit tracking and
// listener fan-out, and arrives here as the same `{ kind: "channel",
// msg }` envelope the editor's worker receives. This file does what
// `src/worker/worker.ts` does with it: `handleMessage` for the JSON
// channel, `loadDocumentDirect` for the binary load, the shaper for the
// two measure kinds, and the resolver after a load or an edit. Nothing
// renders: the GPU / tile paths answer "no image".
//
// Every channel message is RECORDED before the engine sees it. That log
// is what a panel test asserts: the exact wire payload a control sent.
// Replies are delivered on a later microtask, never inside postMessage,
// as a real worker's are.

import type {
  HeadlessCanvasWorker,
  LoadedEngine,
} from "@paged-media/plugin-sdk";
import { loadHeadlessEngine } from "@paged-media/plugin-sdk";

/** One JSON-channel message the client posted, as the engine got it. */
export interface WireMessage {
  seq: number;
  kind: string;
  payload?: unknown;
}

/** A FRESH engine (an empty model) for every mount. The wasm module is
 *  instantiated once per process; later calls only construct a new
 *  `CanvasWorker` over it, so a mount costs a constructor, not a boot. */
export function headlessEngine(): Promise<LoadedEngine> {
  return loadHeadlessEngine();
}

type Listener = (event: MessageEvent) => void;

/** A Worker-shaped door to the in-process engine. */
export class EngineWorker {
  /** Every JSON-channel message, in the order the client posted them. */
  readonly sent: WireMessage[] = [];
  /** The resolver's last pass (TOC, cross-references), as posted. */
  lastResolution: unknown = null;
  /** Message kinds the engine answered with a dispatch error. */
  readonly errors: Array<{ kind: string; details: string }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private inFlight = 0;
  private terminated = false;

  constructor(private readonly engine: HeadlessCanvasWorker) {}

  /** Messages posted and not yet answered. */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(data: unknown, _transfer?: unknown): void {
    if (this.terminated) return;
    this.inFlight += 1;
    queueMicrotask(() => {
      try {
        this.dispatch(data as Incoming);
      } finally {
        this.inFlight -= 1;
      }
    });
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    const event = { data } as MessageEvent;
    for (const l of this.listeners.get("message") ?? []) l(event);
  }

  private dispatch(data: Incoming): void {
    switch (data.kind) {
      case "cameraSab":
      case "gestureSab":
      case "attachCanvas":
      case "resizeCanvas":
        return;
      case "journalDrain":
        this.emit({
          kind: "journalDrainReply",
          seq: data.seq,
          entries: [],
          ledger: [],
          epochWallMs: 0,
        });
        return;
      case "renderPageVelloPng":
        this.emit({ kind: "velloPngReply", seq: data.seq, pngBytes: null });
        return;
      case "direct":
        this.emit({ kind: "directBytesReply", seq: data.seq, bytes: null });
        return;
      case "loadDocumentBinary": {
        const replyJson = this.engine.loadDocumentDirect(
          data.seq,
          data.bytes,
          data.font ?? undefined,
          data.cmykIccProfile ?? undefined,
        );
        this.emit({
          kind: "loadDocumentBinaryReply",
          seq: data.seq,
          replyJson,
        });
        this.resolve();
        return;
      }
      case "channel":
        this.channel(data.msg);
        return;
    }
  }

  private channel(msg: WireMessage & { protocol?: number }): void {
    this.sent.push({ seq: msg.seq, kind: msg.kind, payload: msg.payload });
    const protocol = this.engine.protocolVersion;
    if (msg.kind === "requestMeasureText") {
      const p = msg.payload as MeasurePayload;
      const m = this.engine.measureText?.(
        p.family,
        p.style ?? null,
        p.text,
        p.sizePt,
      );
      this.emit({
        seq: msg.seq,
        protocol,
        kind: "measureTextResult",
        payload: m ?? { advance: 0, ascender: 0, descender: 0 },
      });
      return;
    }
    if (msg.kind === "requestMeasureTextBatch") {
      const p = msg.payload as MeasurePayload & { texts: string[] };
      const zero = { advance: 0, ascender: 0, descender: 0 };
      const metrics = p.texts.map(
        (t) =>
          this.engine.measureText?.(p.family, p.style ?? null, t, p.sizePt) ??
          zero,
      );
      this.emit({
        seq: msg.seq,
        protocol,
        kind: "measureTextBatchResult",
        payload: { metrics },
      });
      return;
    }
    let replyJson: string;
    try {
      replyJson = this.engine.handleMessage(JSON.stringify(msg));
    } catch (err) {
      const details = `channel: ${String(err)}`;
      this.errors.push({ kind: msg.kind, details });
      this.emit({
        seq: msg.seq,
        protocol,
        kind: "warning",
        payload: { kind: "dispatchError", details },
      });
      return;
    }
    if (!replyJson) return;
    const reply = JSON.parse(replyJson) as { kind: string };
    this.emit(reply);
    if (
      reply.kind === "documentLoaded" ||
      reply.kind === "mutationApplied" ||
      reply.kind === "undoApplied" ||
      reply.kind === "redoApplied" ||
      reply.kind === "scriptResult"
    ) {
      this.resolve();
    }
  }

  /** The worker's resolver pass (TOC, cross-references) after a change. */
  private resolve(): void {
    const json = this.engine.runResolveJson();
    if (!json) return;
    this.lastResolution = JSON.parse(json) as unknown;
    this.emit({
      seq: null,
      protocol: this.engine.protocolVersion,
      kind: "resolutionDone",
      payload: this.lastResolution,
    });
  }
}

interface MeasurePayload {
  family: string;
  style?: string | null;
  text: string;
  sizePt: number;
}

type Incoming =
  | { kind: "cameraSab" | "gestureSab" | "attachCanvas" | "resizeCanvas" }
  | { kind: "journalDrain" | "renderPageVelloPng" | "direct"; seq: number }
  | {
      kind: "loadDocumentBinary";
      seq: number;
      bytes: Uint8Array;
      font: Uint8Array | null;
      cmykIccProfile: Uint8Array | null;
    }
  | { kind: "channel"; msg: WireMessage & { protocol?: number } };
