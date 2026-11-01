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

// Editor ADR 290 — the ML worker: the real onnxruntime-web runs a model
// generated in the test (one Sigmoid node), the session reports its
// execution provider, a WebGPU failure falls back to wasm, and errors come
// back as rejections rather than a hung call.

import { describe, expect, test } from "bun:test";

import { tinyOnnxModel } from "../../../src/ml/onnx-fixture";
import {
  createMlWorkerHandler,
  inlineClient,
  type OrtLike,
} from "../../../src/ml/worker-protocol";
import { realOrt, realWorker } from "./kit";

describe("[plugin-platform.ml-service] ML worker over onnxruntime-web", () => {
  test("probe names the runtime and whether WebGPU is there", async () => {
    const w = realWorker(false);
    const p = await w.probe();
    expect(p.webgpu).toBe(false);
    expect(p.runtime).toMatch(/^onnxruntime-web/);
  });

  test("a generated sigmoid model loads on wasm and runs", async () => {
    const w = realWorker();
    const loaded = await w.load("sig", tinyOnnxModel("Sigmoid"));
    expect(loaded).toEqual({
      executionProvider: "wasm",
      inputs: ["image"],
      outputs: ["mask"],
    });
    const out = await w.run("sig", {
      image: { dims: [1, 3, 1, 2], data: new Float32Array([0, 2, 0, 0, 0, 0]) },
    });
    expect(out["mask"]!.dims).toEqual([1, 3, 1, 2]);
    expect(out["mask"]!.data[0]).toBeCloseTo(0.5, 5);
    expect(out["mask"]!.data[1]).toBeCloseTo(1 / (1 + Math.exp(-2)), 5);
  });

  test("an identity model answers its input; Neg negates", async () => {
    const w = realWorker();
    await w.load("id", tinyOnnxModel("Identity", [1, 4]));
    await w.load("neg", tinyOnnxModel("Neg", [1, 4]));
    const input = () => ({
      image: { dims: [1, 4], data: new Float32Array([1, 2, 3, 4]) },
    });
    expect([...(await w.run("id", input()))["mask"]!.data]).toEqual([
      1, 2, 3, 4,
    ]);
    expect([...(await w.run("neg", input()))["mask"]!.data]).toEqual([
      -1, -2, -3, -4,
    ]);
  });

  test("WebGPU first; a model WebGPU cannot build falls back to wasm", async () => {
    const tried: string[][] = [];
    const runtime: OrtLike = {
      ...realOrt,
      InferenceSession: {
        async create(model, options) {
          tried.push(options.executionProviders);
          if (options.executionProviders[0] === "webgpu")
            throw new Error("no webgpu kernel");
          return realOrt.InferenceSession.create(model, options);
        },
      },
    };
    const w = inlineClient(
      createMlWorkerHandler(
        async () => runtime,
        async () => true,
      ),
    );
    const r = await w.load("sig", tinyOnnxModel("Sigmoid"));
    expect(tried).toEqual([["webgpu"], ["wasm"]]);
    expect(r.executionProvider).toBe("wasm");
  });

  test("errors reject: an unknown session, bytes that are no model", async () => {
    const w = realWorker();
    await expect(w.run("nope", {})).rejects.toThrow(/no model loaded as nope/);
    await expect(w.load("junk", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /does not load/,
    );
    await w.load("sig", tinyOnnxModel("Sigmoid"));
    await w.unload("sig");
    await expect(w.run("sig", {})).rejects.toThrow(/no model loaded/);
  });
});
