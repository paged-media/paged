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

// paged-node and the local image model (extensions ADR 345, editor ADR 290),
// against a FAKE paged-ml-host (the host's HTTP API v1, apps/ml-host): the
// health verb, a generate job followed to its PNG and written, an edit job
// sent with its image, mask and references as PNG, the same generation
// through `invoke … paged.ml.generate --result-out`, and the honest failure
// when no host runs. The JSON answers are asserted whole.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decodePng, encodePng } from "../src/ml";
import { cli, tempDir, writeFixture } from "./helpers";

// The surface-conformance marker (a no-op; the gate reads it statically).
const covers = (..._ids: string[]): void => {};

const NP = "--no-plugins";

/** The image the fake host answers every job with: 16×8, a red ramp. */
const ANSWER = {
  width: 16,
  height: 8,
  data: Uint8ClampedArray.from({ length: 16 * 8 * 4 }, (_, i) =>
    i % 4 === 0 ? (i / 4) % 256 : i % 4 === 3 ? 255 : 0,
  ),
};

let server: ReturnType<typeof Bun.serve>;
let HOST = "";
const jobs: Array<Record<string, unknown>> = [];
const tmp = tempDir();
let fx: Awaited<ReturnType<typeof writeFixture>>;

beforeAll(async () => {
  fx = await writeFixture(tmp.dir);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/api/ml/health")
        return Response.json({
          ok: true,
          version: "0.1.0",
          api: 1,
          runtime: { binary: "/opt/sd", found: true },
          model: {
            id: "qwen-image-2.1",
            configured: true,
            licenceAcknowledged: true,
          },
          ready: true,
          capabilities: ["generate", "edit"],
          queue: { running: 0, queued: 0 },
        });
      if (p === "/api/ml/jobs" && req.method === "POST") {
        jobs.push((await req.json()) as Record<string, unknown>);
        return Response.json(
          { id: `j${jobs.length}`, state: "queued" },
          { status: 202 },
        );
      }
      const m = /^\/api\/ml\/jobs\/(j\d+)\/(events|result)$/.exec(p);
      if (m?.[2] === "events")
        return new Response(
          `event: progress\ndata: {"step":1,"total":1}\n\nevent: done\ndata: {"id":"${m[1]}","kind":"generate","state":"done","progress":{"step":1,"total":1}}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      if (m?.[2] === "result")
        return new Response(
          (await encodePng(ANSWER)) as Uint8Array<ArrayBuffer>,
          {
            headers: { "content-type": "image/png" },
          },
        );
      return Response.json(
        { error: "no_job", message: "no such job" },
        { status: 404 },
      );
    },
  });
  HOST = `--ml-host=http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  tmp.done();
});

describe("[plugin-platform.ml-service] paged-node ml", () => {
  it("health", async () => {
    covers("cli:paged-node ml");
    const r = await cli(["ml", "health", HOST]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      host: `http://127.0.0.1:${server.port}`,
      ok: true,
      version: "0.1.0",
      api: 1,
      runtime: { binary: "/opt/sd", found: true },
      model: {
        id: "qwen-image-2.1",
        configured: true,
        licenceAcknowledged: true,
      },
      ready: true,
      capabilities: ["generate", "edit"],
      queue: { running: 0, queued: 0 },
    });
  });

  it("generate writes the host's image", async () => {
    covers("cli:paged-node ml");
    const out = join(tmp.dir, "gen.png");
    const r = await cli([
      "ml",
      "generate",
      "a lighthouse at dusk",
      "-o",
      out,
      "--width",
      "64",
      "--height",
      "128",
      "--seed",
      "7",
      HOST,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      provider: "paged.ml-host",
      tier: "B",
      model: "qwen-image-2.1",
      width: 16,
      height: 8,
      wrote: out,
    });
    expect(jobs.at(-1)).toEqual({
      kind: "generate",
      prompt: "a lighthouse at dusk",
      width: 64,
      height: 128,
      seed: 7,
    });
    const img = await decodePng(new Uint8Array(readFileSync(out)));
    expect([img.width, img.height]).toEqual([16, 8]);
    expect([...img.data]).toEqual([...ANSWER.data]);
  });

  it("edit sends the image, the mask and the references as PNG", async () => {
    covers("cli:paged-node ml");
    const image = join(tmp.dir, "in.png");
    const mask = join(tmp.dir, "mask.png");
    const ref = join(tmp.dir, "ref.png");
    const solid = (v: number) => ({
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(16).fill(v),
    });
    await Bun.write(image, await encodePng(solid(40)));
    await Bun.write(
      mask,
      await encodePng({
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
          255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
        ]),
      }),
    );
    await Bun.write(ref, await encodePng(solid(200)));
    const out = join(tmp.dir, "edit.png");
    const r = await cli([
      "ml",
      "edit",
      "make it night",
      "--image",
      image,
      "--mask",
      mask,
      "--ref",
      ref,
      "--ref",
      ref,
      "--strength",
      "0.6",
      "-o",
      out,
      HOST,
    ]);
    expect(r.code, r.out).toBe(0);
    const job = jobs.at(-1)! as {
      kind: string;
      prompt: string;
      image: string;
      mask: string;
      references: string[];
      strength: number;
    };
    expect([job.kind, job.prompt, job.strength, job.references.length]).toEqual(
      ["edit", "make it night", 0.6, 2],
    );
    const b64 = (s: string) =>
      decodePng(new Uint8Array(Buffer.from(s, "base64")));
    expect([...(await b64(job.image)).data.subarray(0, 4)]).toEqual([
      40, 40, 40, 40,
    ]);
    expect(
      [...(await b64(job.mask)).data].filter((_, i) => i % 4 === 0),
    ).toEqual([255, 0, 0, 255]);
    expect((await b64(job.references[0]!)).data[0]).toBe(200);
  });

  it("invoke paged.ml.generate writes the PNG through --result-out", async () => {
    covers("cli:paged-node ml");
    const out = join(tmp.dir, "invoke.png");
    const r = await cli([
      "invoke",
      fx.paged,
      "paged.ml.generate",
      '{"prompt":"a red ramp","width":64,"height":64}',
      "--no-save",
      "--result-out",
      out,
      NP,
      HOST,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.result).toEqual({
      png: { bytes: expect.any(Number) },
      width: 16,
      height: 8,
      provider: "paged.ml-host",
      tier: "B",
      model: "qwen-image-2.1",
    });
    expect((await decodePng(new Uint8Array(readFileSync(out)))).width).toBe(16);
    expect(jobs.at(-1)).toEqual({
      kind: "generate",
      prompt: "a red ramp",
      width: 64,
      height: 64,
    });
  });

  it("without a running host it says so and fails", async () => {
    covers("cli:paged-node ml");
    const down = "--ml-host=http://127.0.0.1:9";
    const h = await cli(["ml", "health", down]);
    expect(h.code).not.toBe(0);
    expect(h.json.error).toMatch(/local image model not running/);
    const g = await cli([
      "ml",
      "generate",
      "x",
      "-o",
      join(tmp.dir, "x.png"),
      "--width",
      "64",
      "--height",
      "64",
      down,
    ]);
    expect(g.code).not.toBe(0);
    expect(g.json).toMatchObject({
      ok: false,
      wrote: null,
      error: expect.stringMatching(
        /ml\.generate@1: local image model not running/,
      ),
    });
    const bad = await cli([
      "ml",
      "generate",
      "x",
      "-o",
      join(tmp.dir, "x.png"),
      "--width",
      "65",
      HOST,
    ]);
    expect(bad.json.error).toMatch(/multiple of 8/);
  });
});
