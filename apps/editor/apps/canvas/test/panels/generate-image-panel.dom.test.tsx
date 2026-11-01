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

// Generate Image (paged.generate-image, editor ADR 313): a prompt fills an
// image frame of ANY page, or a new frame made for it, through the ML doors
// (the SDK's fake provider here: no model runs), as ONE undo step. A refusal
// is the registry's own sentence and changes nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { act } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import {
  createMlHostClient,
  createMlRegistry,
  fakeMlProvider,
  mlUnavailable,
} from "@paged-media/plugin-sdk";
import type { MlImage } from "@paged-media/plugin-api";
import { createEditorScope } from "@paged-media/shell";

import { buildInsertCommands } from "../../src/insert-commands";
import {
  generateImageHandler,
  generationSize,
} from "../../src/ml/generate-image";
import { createMemoryModelFiles, ModelStore } from "../../src/ml/model-store";
import { SHIPPED_REGISTRY } from "../../src/ml/registry";
import { setMlService } from "../../src/ml/scope";
import { MlService } from "../../src/ml/service";
import { GenerateImagePanel } from "../../src/panels/generate-image-panel";
import { ORIGIN, publicFetch } from "../unit/ml/kit";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 30)));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
};
/** A real PNG (the engine decodes what it is given). */
function encodePng(image: MlImage): Uint8Array {
  const { width, height } = image;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      image.data.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const head = new Uint8Array(13);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  head.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function service(opts: { provider: boolean }) {
  const backend = createMlRegistry();
  const provider = fakeMlProvider({ tier: "B", capabilities: ["generate"] });
  if (opts.provider) provider.attach(backend.register(provider));
  const svc = new MlService({
    backend,
    registry: SHIPPED_REGISTRY,
    store: new ModelStore({
      files: createMemoryModelFiles(),
      origin: ORIGIN,
      fetch: publicFetch().fetch,
    }),
    worker: null,
    host: createMlHostClient({
      baseUrl: "",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    }),
    codec: {
      decode: async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      }),
      encode: async (image) => encodePng(image),
    },
    settings: { get: () => null, set: () => undefined },
    detectGpu: async () => ({ webgpu: false, reason: "test" }),
    pollMs: 0,
  });
  return { svc, provider };
}

async function mount(opts: { provider?: boolean } = {}) {
  const { svc, provider } = service({ provider: opts.provider ?? true });
  const scope = createEditorScope();
  setMlService(scope, svc);
  const h = await mountPanel(GenerateImagePanel, {
    id: "paged.generate-image",
    scene: richScene,
    scope,
  });
  return { h, svc, provider };
}

const q = (root: Element, sel: string) =>
  root.querySelector(sel) as HTMLElement | null;

async function typePrompt(root: HTMLElement, text: string) {
  const { fireEvent } = await import("@testing-library/react");
  await act(async () => {
    fireEvent.change(q(root, "[data-generate-prompt]")!, {
      target: { value: text },
    });
  });
}

const hasImage = async (
  h: Awaited<ReturnType<typeof mount>>["h"],
  id: Parameters<typeof h.client.elementGeometry>[0][number],
) => (await h.client.elementGeometry([id]))[0]?.hasImage === true;

describe("Generate image panel [editor-shell.generate-image]", () => {
  test("the size is the frame's aspect, multiples of 8 within the doors' range", () => {
    expect(generationSize(100, 100)).toEqual({ width: 1024, height: 1024 });
    expect(generationSize(1600, 900)).toEqual({ width: 1024, height: 576 });
    expect(generationSize(900, 1600)).toEqual({ width: 576, height: 1024 });
    expect(generationSize(1000, 1)).toEqual({ width: 1024, height: 64 });
  });

  test("a selected frame is filled: one mutation, one undo step", async () => {
    covers("panel:paged.generate-image");
    const { h, provider } = await mount();
    await h.select([h.scene.rect]);
    expect(await hasImage(h, h.scene.rect)).toBe(false);
    expect(q(h.root, "[data-generate-target]")!.dataset["generateTarget"]).toBe(
      "frame",
    );
    await typePrompt(h.root, "a lighthouse");
    const from = h.mark();
    await act(async () => q(h.root, '[data-action="generate-image"]')!.click());
    await settle();
    const mutations = h.mutations(from);
    expect(mutations.map((m) => m.op)).toEqual(["replaceImageBytes"]);
    expect(await hasImage(h, h.scene.rect)).toBe(true);
    expect(provider.calls.length).toBe(1);
    const asked = provider.calls[0]!.request as {
      prompt: string;
      width: number;
      height: number;
    };
    expect(asked.prompt).toBe("a lighthouse");
    expect(asked.width % 8).toBe(0);
    expect(q(h.root, "[data-generate-status]")!.dataset["generateStatus"]).toBe(
      "done",
    );
    await h.act(() => h.client.undo());
    expect(await hasImage(h, h.scene.rect)).toBe(false);
  });

  test("with nothing selected a new frame is made and filled in one batch, one undo step", async () => {
    covers("panel:paged.generate-image");
    const { h } = await mount();
    await h.select([]);
    expect(q(h.root, "[data-generate-target]")!.dataset["generateTarget"]).toBe(
      "new",
    );
    await typePrompt(h.root, "a red door");
    const from = h.mark();
    await act(async () => q(h.root, '[data-action="generate-image"]')!.click());
    await settle();
    expect(h.mutations(from).map((m) => m.op)).toEqual(["batch"]);
    const created = h.paged.selection.elementSelection;
    expect(created.length).toBe(1);
    expect(await hasImage(h, created[0]!)).toBe(true);
    await h.act(() => h.client.undo());
    expect(await hasImage(h, created[0]!)).toBe(false);
    expect((await h.client.elementGeometry([created[0]!])).length).toBe(0);
  });

  test("with no model running the registry's sentence is shown and nothing changes", async () => {
    covers("panel:paged.generate-image");
    const { h } = await mount({ provider: false });
    await h.select([h.scene.rect]);
    await typePrompt(h.root, "anything");
    const from = h.mark();
    await act(async () => q(h.root, '[data-action="generate-image"]')!.click());
    await settle();
    expect(h.mutations(from)).toEqual([]);
    const alert = q(h.root, '[role="alert"]')!;
    expect(alert.textContent).toContain(mlUnavailable("generate"));
    expect(await hasImage(h, h.scene.rect)).toBe(false);
  });

  test("an empty prompt cannot be sent", async () => {
    covers("panel:paged.generate-image");
    const { h } = await mount();
    expect(
      (q(h.root, '[data-action="generate-image"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("the command takes the same request: a script generates without the panel", async () => {
    covers("command:paged.insert.generateImage");
    const { h, svc } = await mount();
    await h.select([h.scene.rect]);
    const run = generateImageHandler({
      generate: (r, o) => svc.generateImage(r, o),
      report: () => undefined,
    });
    const cmd = buildInsertCommands(
      new Proxy(
        { generateImage: run },
        { get: (t, k) => (t as never)[k] ?? (() => undefined) },
      ) as never,
    ).find((c) => c.id === "paged.insert.generateImage")!;
    expect(cmd.id).toBe("paged.insert.generateImage");
    const from = h.mark();
    await act(async () => {
      await cmd.handler(h.paged, { prompt: "scripted" });
    });
    expect(h.mutations(from).map((m) => m.op)).toEqual(["replaceImageBytes"]);
    expect(await hasImage(h, h.scene.rect)).toBe(true);
  });
});
