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

// Who owns the bytes that cross the iframe bridge. A transfer list moves an
// ArrayBuffer and leaves the sender's array empty, so the bridge lists only
// buffers it alone holds (what a handle's method answered in the frame).
// Bytes the embedding page passes in (`load`, the config's `document`) and
// bytes the editor hands to a host action (`save`) are copied: the caller's
// array keeps its length and contents. Both sides run here against windows
// whose `postMessage` is a structured clone that honours the transfer list,
// as a browser's is.

import { describe, expect, test } from "bun:test";

import { serveBridge } from "../../src/embed/bridge";
import { connectEditor, type ConnectConfig } from "../../src/embed/connect";
import type { EditorConfig, EditorHandle } from "../../src/embed/create-editor";

const HOST = "https://host.example";
const FRAME = "https://editor.example";
const BYTES = [80, 75, 3, 4, 9, 8, 7, 6];

type Posted = { type: string } & Record<string, unknown>;

/** A host page and a framed editor, joined by cloning windows. */
function rig(editor: Partial<EditorHandle>, config: ConnectConfig = {}) {
  const frameSelf = new EventTarget();
  const deliver = (
    target: EventTarget,
    msg: unknown,
    transfer: Transferable[] | undefined,
    origin: string,
    source: unknown,
  ) => {
    const data = structuredClone(msg, { transfer: transfer ?? [] });
    queueMicrotask(() =>
      target.dispatchEvent(
        Object.assign(new Event("message"), { data, origin, source }),
      ),
    );
    return data as Posted;
  };
  const toFrame: Posted[] = [];
  const toHost: Posted[] = [];
  // The iframe's window, as the host page sees it.
  const frameWindow = {
    postMessage: (msg: unknown, _origin: string, transfer?: Transferable[]) =>
      toFrame.push(deliver(frameSelf, msg, transfer, HOST, parent)),
  };
  // The host page's window, as the frame sees it.
  const parent: { postMessage: Window["postMessage"] } = {
    postMessage: ((msg: unknown, _origin: string, transfer?: Transferable[]) =>
      toHost.push(
        deliver(window, msg, transfer, FRAME, frameWindow),
      )) as Window["postMessage"],
  };
  const attributes = new Map<string, string>();
  const iframe = {
    src: `${FRAME}/embed.html`,
    contentWindow: frameWindow,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) =>
      void attributes.set(name, value),
  } as unknown as HTMLIFrameElement;

  const made: EditorConfig[] = [];
  const connected = connectEditor(iframe, { timeout: 2000, ...config });
  const served = serveBridge({
    element: document.createElement("div"),
    peer: parent as Window,
    self: frameSelf as unknown as Window,
    origins: [HOST],
    create: async (_element, c) => {
      made.push(c);
      return { on: () => () => {}, ...editor } as unknown as EditorHandle;
    },
  });
  return { connected, served, made, toFrame, toHost };
}

describe("iframe bridge: whose bytes", () => {
  test("load leaves the caller's bytes whole, and the frame gets the same bytes", async () => {
    const loaded: number[][] = [];
    const r = rig({
      load: async (document) => void loaded.push([...document.bytes]),
    });
    const handle = await r.connected;
    const bytes = Uint8Array.from(BYTES);
    await handle.load({ bytes, name: "card.paged" });
    expect(loaded).toEqual([BYTES]);
    expect(bytes.byteLength).toBe(BYTES.length);
    expect([...bytes]).toEqual(BYTES);
    // The host can send them again.
    await handle.load({ bytes });
    expect(loaded).toEqual([BYTES, BYTES]);
    handle.dispose();
  });

  test("the config's document stays the host's", async () => {
    const bytes = Uint8Array.from(BYTES);
    const r = rig({}, { document: { bytes, name: "card.paged" } });
    const handle = await r.connected;
    expect([...r.made[0]!.document!.bytes]).toEqual(BYTES);
    expect([...bytes]).toEqual(BYTES);
    handle.dispose();
  });

  test("transferBuffers moves the caller's bytes instead (opt-in)", async () => {
    const loaded: number[][] = [];
    const r = rig(
      { load: async (document) => void loaded.push([...document.bytes]) },
      { transferBuffers: true },
    );
    const handle = await r.connected;
    // The option is the host's side only: the frame's config has none.
    expect("transferBuffers" in r.made[0]!).toBe(false);
    const bytes = Uint8Array.from(BYTES);
    await handle.load({ bytes });
    expect(loaded).toEqual([BYTES]);
    expect(bytes.byteLength).toBe(0);
    handle.dispose();
  });

  test("what a method answers is the bridge's: its buffer moves to the host", async () => {
    const answered = Uint8Array.from(BYTES);
    const r = rig({ save: async () => answered });
    const handle = await r.connected;
    const saved = await handle.save();
    expect(saved).toBeInstanceOf(Uint8Array);
    expect([...saved]).toEqual(BYTES);
    expect(answered.byteLength).toBe(0);
    handle.dispose();
  });

  test("a host save keeps the editor's bytes whole, and the host gets the same bytes", async () => {
    const got: { bytes: number[]; name: string }[] = [];
    const r = rig(
      {},
      {
        actions: {
          save: (file) => void got.push({ ...file, bytes: [...file.bytes] }),
        },
      },
    );
    const handle = await r.connected;
    await r.served;
    const save = r.made[0]!.actions!.save!;
    const bytes = Uint8Array.from(BYTES);
    await save({ bytes, name: "card.paged" });
    expect(got).toEqual([{ bytes: BYTES, name: "card.paged" }]);
    expect(bytes.byteLength).toBe(BYTES.length);
    expect([...bytes]).toEqual(BYTES);
    handle.dispose();
  });
});
