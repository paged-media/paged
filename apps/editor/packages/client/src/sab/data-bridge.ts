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

// `paged.data.*` in the worker's scripts (engine ADR 1014, amendment 2).
//
// The interpreter calls its data door synchronously; the data lives on the
// main thread behind an async service. So the worker posts each call to the
// main thread and BLOCKS on `Atomics.wait` over a shared buffer until the
// main thread has written the answer and `Atomics.notify`d. The main thread
// is never blocked: it answers when the service does.
//
// The buffer: a 16-byte header of four Int32 words, then the payload.
//
//   word 0  READY   id of the call whose chunk is in the payload (0: none)
//   word 1  TOTAL   the answer's UTF-8 byte length
//   word 2  OFFSET  where in the answer this chunk starts
//   word 3  LENGTH  this chunk's byte length
//
// An answer larger than the payload goes in chunks: the worker copies one
// out, clears READY and posts `dataMore` with the offset it wants next.
// The main thread writes only for the LATEST call it was sent, so a late
// answer to a call the worker gave up on (its timeout) is dropped, and one
// that lands before the next call's message carries the old id, which the
// worker skips. The answer is the engine bridge's JSON envelope, `{ ok }`
// or `{ error }`; the worker side never throws.
//
// Worker code imports this module (React-free, like the rest of the
// package).

export const DATA_BRIDGE_HEADER_BYTES = 16;
/** The default payload capacity; larger answers are chunked. */
export const DATA_BRIDGE_CAPACITY = 1 << 20;
/** How long a script waits for one data call before it fails. */
export const DATA_CALL_TIMEOUT_MS = 30_000;

const READY = 0;
const TOTAL = 1;
const OFFSET = 2;
const LENGTH = 3;

/** Worker → main: one `paged.data` call (`args` is the JSON array). */
export interface DataCallMessage {
  kind: "dataCall";
  id: number;
  method: string;
  args: string;
}

/** Worker → main: the next chunk of call `id`'s answer, from `offset`. */
export interface DataMoreMessage {
  kind: "dataMore";
  id: number;
  offset: number;
}

export type DataBridgeMessage = DataCallMessage | DataMoreMessage;

/** Answers one call: the service's value, or a throw the script sees. */
export type DataCallAnswerer = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** The shared buffer of one bridge (`capacity` payload bytes). */
export function allocateDataBridge(
  capacity: number = DATA_BRIDGE_CAPACITY,
): SharedArrayBuffer {
  return new SharedArrayBuffer(DATA_BRIDGE_HEADER_BYTES + capacity);
}

export function isDataBridgeMessage(data: unknown): data is DataBridgeMessage {
  const kind = (data as { kind?: unknown } | null)?.kind;
  return kind === "dataCall" || kind === "dataMore";
}

function errorEnvelope(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * The worker's half: a synchronous `(method, argsJson) => answerJson`, the
 * function the engine's `setScriptDataBridge` takes. `post` sends a
 * {@link DataBridgeMessage} to the main thread.
 */
export function createDataBridgeCaller(
  buffer: SharedArrayBuffer,
  post: (message: DataBridgeMessage) => void,
  options: { timeoutMs?: number; now?: () => number } = {},
): (method: string, argsJson: string) => string {
  const header = new Int32Array(buffer, 0, 4);
  const payload = new Uint8Array(buffer, DATA_BRIDGE_HEADER_BYTES);
  const timeoutMs = options.timeoutMs ?? DATA_CALL_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  const decoder = new TextDecoder();
  let lastId = 0;
  return (method, argsJson) => {
    lastId = lastId >= 0x7fffffff ? 1 : lastId + 1;
    const id = lastId;
    const deadline = now() + timeoutMs;
    post({ kind: "dataCall", id, method, args: argsJson });
    let answer: Uint8Array | null = null;
    let received = 0;
    for (;;) {
      const ready = Atomics.load(header, READY);
      if (ready !== id) {
        const left = deadline - now();
        if (left <= 0)
          return errorEnvelope(
            `no answer from the editor's data service within ${timeoutMs} ms`,
          );
        Atomics.wait(header, READY, ready, left);
        continue;
      }
      const total = Atomics.load(header, TOTAL);
      const offset = Atomics.load(header, OFFSET);
      const length = Atomics.load(header, LENGTH);
      // Copied out of shared memory: TextDecoder refuses a shared view.
      answer ??= new Uint8Array(total);
      answer.set(payload.subarray(0, length), offset);
      received = offset + length;
      Atomics.compareExchange(header, READY, id, 0);
      if (received >= total) return decoder.decode(answer);
      post({ kind: "dataMore", id, offset: received });
    }
  };
}

/**
 * The main thread's half: answers the worker's {@link DataBridgeMessage}s
 * through `answer` and writes them into `buffer`.
 */
export class DataBridgeHost {
  private readonly header: Int32Array;
  private readonly payload: Uint8Array;
  private readonly encoder = new TextEncoder();
  /** The latest call the worker sent, and its answer once it is known. */
  private current: { id: number; bytes: Uint8Array | null } | null = null;

  constructor(
    buffer: SharedArrayBuffer,
    private readonly answer: DataCallAnswerer,
  ) {
    this.header = new Int32Array(buffer, 0, 4);
    this.payload = new Uint8Array(buffer, DATA_BRIDGE_HEADER_BYTES);
  }

  /** Handle one worker message; `false` when it is not the bridge's. */
  handle(message: unknown): boolean {
    if (!isDataBridgeMessage(message)) return false;
    if (message.kind === "dataCall") void this.call(message);
    else if (this.current?.id === message.id && this.current.bytes)
      this.write(message.id, this.current.bytes, message.offset);
    return true;
  }

  private async call(message: DataCallMessage): Promise<void> {
    const call = { id: message.id, bytes: null as Uint8Array | null };
    this.current = call;
    const json = await this.envelope(message);
    if (this.current !== call) return;
    call.bytes = this.encoder.encode(json);
    this.write(call.id, call.bytes, 0);
  }

  private async envelope(message: DataCallMessage): Promise<string> {
    let args: unknown;
    try {
      args = JSON.parse(message.args);
    } catch {
      return errorEnvelope(`malformed arguments to ${message.method}`);
    }
    try {
      const value = await this.answer(
        message.method,
        Array.isArray(args) ? args : [],
      );
      return JSON.stringify({ ok: value ?? null });
    } catch (err) {
      return errorEnvelope(err instanceof Error ? err.message : String(err));
    }
  }

  private write(id: number, bytes: Uint8Array, offset: number): void {
    const length = Math.min(this.payload.length, bytes.length - offset);
    this.payload.set(bytes.subarray(offset, offset + length), 0);
    Atomics.store(this.header, TOTAL, bytes.length);
    Atomics.store(this.header, OFFSET, offset);
    Atomics.store(this.header, LENGTH, length);
    Atomics.store(this.header, READY, id);
    Atomics.notify(this.header, READY);
  }
}
