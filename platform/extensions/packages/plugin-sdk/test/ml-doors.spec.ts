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

// Extensions ADR 345 — the ML doors (`host.ml`, ml.<capability>@1).
//
// Coverage:
//   1. routing: a registered healthy provider answers, the result names the
//      provider, tier and model; Tier A is preferred for analysis and Tier B
//      for generation; an asked tier is honoured; an unhealthy provider is
//      skipped and the call says what is missing;
//   2. supports("ml.x@1") is live: false without a backend, true once a
//      healthy provider registers, false again when it goes down or leaves;
//   3. the gate: a capability the manifest does not list is refused;
//   4. request checks: RGBA length, mask size, prompt, size, references;
//   5. the fake provider's deterministic answers, progress and abort;
//   6. the Tier-B client and provider against a fake local host: health,
//      config, a generate job followed over SSE to its PNG, an edit job's
//      body, cancel on abort, a refusal's code.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type {
  MlCapability,
  MlImage,
  PluginManifest,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  createMlHostClient,
  createMlRegistry,
  fakeMlProvider,
  mlHostProvider,
  mlObjectModel,
  MlHostError,
  PluginCapabilityError,
  toBase64,
  type MlBackend,
  type MlHostJobRequest,
} from "../src";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const manifest = (
  id: string,
  ml: MlCapability[] | undefined,
): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: ml ? { ml } : {},
});

const ALL: MlCapability[] = [
  "segment",
  "matting",
  "inpaint",
  "superres",
  "landmarks",
  "generate",
  "edit",
];

function host(ml: MlCapability[] | undefined, backend?: MlBackend) {
  return createBundleHost(
    () => makeFakeEditor().editor,
    manifest("com.example.ml", ml),
    { console: silent, ml: backend, capabilityMode: "enforce" },
  ).host;
}

const rgba = (width: number, height: number, fill = 200): MlImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(fill),
});

describe("[plugin-platform.ml-service] ml doors: routing", () => {
  it("a healthy provider answers and the result names it", async () => {
    const backend = createMlRegistry();
    const fake = fakeMlProvider({ id: "fake.a", model: "tiny" });
    fake.attach(backend.register(fake));
    const h = host(ALL, backend);
    const r = await h.ml.matting({ image: rgba(4, 2) });
    expect(r.provider).toBe("fake.a");
    expect(r.tier).toBe("A");
    expect(r.model).toBe("tiny");
    expect(r.alpha.width).toBe(4);
    expect([...r.alpha.data]).toEqual(new Array(8).fill(255));
  });

  it("Tier A first for analysis, Tier B first for generation, an asked tier wins", async () => {
    const backend = createMlRegistry();
    backend.register(fakeMlProvider({ id: "a", tier: "A" }));
    backend.register(fakeMlProvider({ id: "b", tier: "B" }));
    const h = host(ALL, backend);
    expect(
      (
        await h.ml.inpaint({
          image: rgba(2, 2),
          mask: { width: 2, height: 2, data: new Uint8Array(4) },
        })
      ).provider,
    ).toBe("a");
    expect(
      (await h.ml.generate({ prompt: "x", width: 64, height: 64 })).provider,
    ).toBe("b");
    expect(
      (
        await h.ml.generate(
          { prompt: "x", width: 64, height: 64 },
          { tier: "A" },
        )
      ).provider,
    ).toBe("a");
  });

  it("an unhealthy provider is skipped; with none, the call says what is missing", async () => {
    const backend = createMlRegistry();
    const b = fakeMlProvider({
      id: "b",
      tier: "B",
      capabilities: ["generate", "edit"],
    });
    b.attach(backend.register(b));
    b.setHealthy(false);
    const h = host(ALL, backend);
    await expect(
      h.ml.generate({ prompt: "a fox", width: 64, height: 64 }),
    ).rejects.toThrow(/ml\.generate@1: local image model not running/);
    await expect(h.ml.segment({ image: rgba(2, 2) })).rejects.toThrow(
      /ml\.segment@1: no model installed/,
    );
    expect(backend.providers()).toEqual([
      expect.objectContaining({ id: "b", healthy: false, tier: "B" }),
    ]);
  });

  it("a second provider with the same id is refused", () => {
    const backend = createMlRegistry();
    backend.register(fakeMlProvider({ id: "x" }));
    expect(() => backend.register(fakeMlProvider({ id: "x" }))).toThrow(
      /registered already/,
    );
  });
});

describe("[plugin-platform.ml-service] ml doors: supports is live", () => {
  it("false without a backend; every call rejects", async () => {
    const h = host(ALL);
    for (const c of ALL) expect(h.supports(`ml.${c}@1`)).toBe(false);
    expect(h.ml.providers()).toEqual([]);
    await expect(h.ml.matting({ image: rgba(1, 1) })).rejects.toThrow(
      /ml\.matting@1/,
    );
  });

  it("follows registration and health, and fires onDidChange", () => {
    const backend = createMlRegistry();
    const h = host(ALL, backend);
    let fired = 0;
    h.ml.onDidChange(() => fired++);
    expect(h.supports("ml.generate@1")).toBe(false);
    const p = fakeMlProvider({
      id: "b",
      tier: "B",
      capabilities: ["generate"],
    });
    const handle = backend.register(p);
    p.attach(handle);
    expect(h.supports("ml.generate@1")).toBe(true);
    expect(h.supports("ml.edit@1")).toBe(false);
    p.setHealthy(false);
    expect(h.supports("ml.generate@1")).toBe(false);
    p.setHealthy(true);
    handle.dispose();
    expect(h.supports("ml.generate@1")).toBe(false);
    expect(fired).toBe(4);
    expect(h.supports("ml.unknown@1")).toBe(false);
  });
});

describe("[plugin-platform.ml-service] ml doors: gate and checks", () => {
  const backend = createMlRegistry();
  backend.register(fakeMlProvider());

  it("a capability the manifest does not list is refused", async () => {
    const h = host(["segment"], backend);
    await expect(
      h.ml.generate({ prompt: "x", width: 64, height: 64 }),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
    await expect(
      host(undefined, backend).ml.segment({ image: rgba(1, 1) }),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
    expect((await h.ml.segment({ image: rgba(1, 1) })).mask.data.length).toBe(
      1,
    );
  });

  it("requests are checked before a provider sees them", async () => {
    const h = host(ALL, backend);
    const bad = { width: 2, height: 2, data: new Uint8ClampedArray(3) };
    await expect(h.ml.matting({ image: bad })).rejects.toThrow(
      /RGBA 2×2 needs 16/,
    );
    await expect(
      h.ml.inpaint({
        image: rgba(2, 2),
        mask: { width: 1, height: 1, data: new Uint8Array(1) },
      }),
    ).rejects.toThrow(/mask is 1×1; the image is 2×2/);
    await expect(
      h.ml.generate({ prompt: " ", width: 64, height: 64 }),
    ).rejects.toThrow(/prompt is empty/);
    await expect(
      h.ml.generate({ prompt: "x", width: 65, height: 64 }),
    ).rejects.toThrow(/multiple of 8/);
    await expect(
      h.ml.edit({
        prompt: "x",
        image: rgba(1, 1),
        references: Array.from({ length: 11 }, () => rgba(1, 1)),
      }),
    ).rejects.toThrow(/at most 10 references/);
    await expect(
      h.ml.superres({ image: rgba(1, 1), scale: 3 as 2 }),
    ).rejects.toThrow(/scale is 2 or 4/);
    await expect(
      h.ml.segment({
        image: rgba(1, 1),
        points: [{ x: 0, y: 0, label: 2 as 1 }],
      }),
    ).rejects.toThrow(/label/);
  });
});

describe("[plugin-platform.ml-service] ml doors: the fake provider", () => {
  it("answers each capability deterministically, with progress, and aborts", async () => {
    const backend = createMlRegistry();
    backend.register(fakeMlProvider({ steps: 3 }));
    const h = host(ALL, backend);
    const steps: number[] = [];
    const g = await h.ml.generate(
      { prompt: "abc", width: 64, height: 64 },
      { onProgress: (p) => steps.push(p.step) },
    );
    expect(steps).toEqual([1, 2, 3]);
    expect(g.image.width).toBe(64);
    expect(g.image.data[0]).toBe(3);
    expect(g.image.data[3]).toBe(255);
    const s = await h.ml.superres({ image: rgba(2, 1), scale: 4 });
    expect([s.image.width, s.image.height]).toEqual([8, 4]);
    const l = await h.ml.landmarks({ image: rgba(9, 9) });
    expect(l.faces[0]!.points).toHaveLength(5);
    const mask = { width: 2, height: 1, data: new Uint8Array([255, 0]) };
    const e = await h.ml.edit({
      prompt: "invert",
      image: rgba(2, 1, 200),
      mask,
    });
    expect([...e.image.data.subarray(0, 4)]).toEqual([55, 55, 55, 200]);
    expect([...e.image.data.subarray(4, 8)]).toEqual([200, 200, 200, 200]);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      h.ml.generate(
        { prompt: "x", width: 64, height: 64 },
        { signal: ctl.signal },
      ),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------- the fake host

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("[plugin-platform.ml-service] the Tier-B client against a fake local host", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const jobs = new Map<
    string,
    { body: MlHostJobRequest; state: string; hold: boolean }
  >();
  let ready = true;
  let n = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const p = url.pathname;
        if (p === "/api/ml/health")
          return Response.json({
            ok: true,
            version: "0.1.0",
            api: 1,
            runtime: { binary: "/x/sd", found: true },
            model: {
              id: ready ? "qwen-image-2.1" : null,
              configured: ready,
              licenceAcknowledged: ready,
            },
            ready,
            capabilities: ready ? ["generate", "edit"] : [],
            queue: { running: 0, queued: 0 },
          });
        if (p === "/api/ml/config" && req.method === "PUT") {
          const body = (await req.json()) as {
            model?: { licenceAcknowledged?: boolean };
          };
          if (body.model && body.model.licenceAcknowledged !== true)
            return Response.json(
              {
                error: "licence_not_acknowledged",
                message: "acknowledge the licence first",
              },
              { status: 409 },
            );
          return Response.json(body);
        }
        if (p === "/api/ml/jobs" && req.method === "POST") {
          if (!ready)
            return Response.json(
              { error: "not_ready", message: "no model configured" },
              { status: 503 },
            );
          const body = (await req.json()) as MlHostJobRequest;
          const id = `j${++n}`;
          jobs.set(id, { body, state: "queued", hold: body.prompt === "hold" });
          return Response.json({ id, state: "queued" }, { status: 202 });
        }
        const m = /^\/api\/ml\/jobs\/([^/]+)(\/events|\/result)?$/.exec(p);
        const job = m ? jobs.get(m[1]!) : undefined;
        if (!m || !job)
          return Response.json(
            { error: "no_job", message: "no such job" },
            { status: 404 },
          );
        const id = m[1]!;
        const json = () => ({
          id,
          kind: job.body.kind,
          state: job.state,
          progress: { step: 2, total: 2 },
        });
        if (req.method === "DELETE") {
          job.state = "cancelled";
          return Response.json(json());
        }
        if (m[2] === "/result")
          return new Response(PNG, {
            headers: { "content-type": "image/png" },
          });
        if (m[2] === "/events") {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            async start(c) {
              c.enqueue(
                enc.encode(`event: state\ndata: {"state":"running"}\n\n`),
              );
              c.enqueue(
                enc.encode(`event: progress\ndata: {"step":1,"total":2}\n\n`),
              );
              while (job.hold && job.state !== "cancelled") await Bun.sleep(5);
              if (job.state !== "cancelled") {
                c.enqueue(
                  enc.encode(`event: progress\ndata: {"step":2,"total":2}\n\n`),
                );
                job.state = "done";
              }
              c.enqueue(
                enc.encode(
                  `event: ${job.state}\ndata: ${JSON.stringify(json())}\n\n`,
                ),
              );
              c.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(json());
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  it("follows a generate job over SSE to its PNG", async () => {
    const client = createMlHostClient({ baseUrl: base });
    expect((await client.health()).ready).toBe(true);
    const steps: string[] = [];
    const png = await client.run(
      { kind: "generate", prompt: "a lighthouse", width: 512, height: 512 },
      { onProgress: (p) => steps.push(`${p.step}/${p.total}`) },
    );
    expect([...png]).toEqual([...PNG]);
    expect(steps).toEqual(["1/2", "2/2"]);
  });

  it("the licence gate's refusal keeps its code", async () => {
    const client = createMlHostClient({ baseUrl: base });
    const err = await client
      .configure({
        sdBinary: "/x/sd",
        model: {
          id: "qwen-image-2.1",
          licenceId: "qwen-research",
          licenceAcknowledged: false,
          diffusionModel: "a",
          textEncoder: "b",
          vae: "c",
        },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlHostError);
    expect((err as MlHostError).code).toBe("licence_not_acknowledged");
    expect((err as MlHostError).status).toBe(409);
  });

  it("aborting cancels the job", async () => {
    const client = createMlHostClient({ baseUrl: base });
    const ctl = new AbortController();
    const running = client.run(
      { kind: "generate", prompt: "hold", width: 64, height: 64 },
      { signal: ctl.signal },
    );
    await Bun.sleep(30);
    ctl.abort();
    await expect(running).rejects.toThrow();
    expect(
      [...jobs.values()].find((j) => j.body.prompt === "hold")!.state,
    ).toBe("cancelled");
  });

  it("an unreachable host says the local model is not running", async () => {
    const client = createMlHostClient({ baseUrl: "http://127.0.0.1:9" });
    const err = (await client.health().catch((e: unknown) => e)) as MlHostError;
    expect(err.code).toBe("unreachable");
    expect(err.message).toMatch(/local image model not running/);
  });

  it("the provider is healthy while the host is ready, and sends edits as PNG", async () => {
    const backend = createMlRegistry();
    const codec = {
      async encode(img: MlImage) {
        return new Uint8Array([img.width, img.height, img.data[0]!]);
      },
      async decode() {
        return rgba(3, 3, 7);
      },
    };
    let changed = 0;
    const provider = mlHostProvider({
      client: createMlHostClient({ baseUrl: base }),
      codec,
      onStatus: () => changed++,
    });
    backend.register(provider);
    const h = host(ALL, backend);
    expect(h.supports("ml.generate@1")).toBe(false);
    await provider.refresh();
    expect(changed).toBe(1);
    expect(h.supports("ml.generate@1")).toBe(true);
    expect(h.supports("ml.edit@1")).toBe(true);
    expect(h.supports("ml.segment@1")).toBe(false);
    const r = await h.ml.edit({
      prompt: "make it night",
      image: rgba(2, 2, 9),
      mask: { width: 2, height: 2, data: new Uint8Array([255, 0, 0, 0]) },
      references: [rgba(1, 1, 5)],
    });
    expect(r).toMatchObject({
      provider: "paged.ml-host",
      tier: "B",
      model: "qwen-image-2.1",
    });
    expect(r.image.width).toBe(3);
    const sent = [...jobs.values()].at(-1)!.body as Extract<
      MlHostJobRequest,
      { kind: "edit" }
    >;
    expect(sent.image).toBe(toBase64(new Uint8Array([2, 2, 9])));
    expect(sent.mask).toBe(toBase64(new Uint8Array([2, 2, 255])));
    expect(sent.references).toEqual([toBase64(new Uint8Array([1, 1, 5]))]);
    ready = false;
    await provider.refresh();
    expect(h.supports("ml.generate@1")).toBe(false);
    expect(provider.status().detail).toBe("no model configured");
    ready = true;
  });

  it("base64 matches the platform's", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 300]) {
      const b = new Uint8Array(len).map((_, i) => (i * 37) & 255);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
    }
  });
});

describe("[plugin-platform.ml-service] typed commands paged.ml.generate / paged.ml.edit", () => {
  const codec = {
    encode: async (img: MlImage) =>
      new Uint8Array([img.width, img.height, img.data[0]!]),
    decode: async (png: Uint8Array) => rgba(png[0]!, png[1]!, png[2]!),
  };
  it("generate answers PNG bytes and who answered; edit decodes its inputs", async () => {
    const backend = createMlRegistry();
    const fake = fakeMlProvider({ id: "b", tier: "B", model: "m" });
    backend.register(fake);
    const model = mlObjectModel(backend, codec);
    const [generate, edit] = model.commands!;
    expect(generate!.id).toBe("paged.ml.generate");
    const g = (await generate!.handler!({} as never, {
      prompt: "abc",
      width: 64,
      height: 64,
    })) as Record<string, unknown>;
    expect(g).toEqual({
      png: new Uint8Array([64, 64, 3]),
      width: 64,
      height: 64,
      provider: "b",
      tier: "B",
      model: "m",
    });
    const e = (await edit!.handler!({} as never, {
      prompt: "x",
      image: new Uint8Array([2, 2, 10]),
      mask: new Uint8Array([2, 2, 255]),
    })) as Record<string, unknown>;
    expect(e["png"]).toEqual(new Uint8Array([2, 2, 245]));
    const sent = fake.calls.at(-1)!.request as { mask: { data: Uint8Array } };
    expect([...sent.mask.data]).toEqual([255, 255, 255, 255]);
    await expect(
      generate!.handler!({} as never, { prompt: "x", width: 63, height: 64 }),
    ).rejects.toThrow(/multiple of 8/);
  });
});
