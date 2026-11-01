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

// Editor ADR 290 — the shared test kit of the ML service's unit tests: the
// real onnxruntime-web (its Node build, wasm execution provider) behind the
// worker handler, called in the same thread; a fetch that serves the
// shipped fixtures from public/.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ort from "onnxruntime-web";

import {
  createMlWorkerHandler,
  inlineClient,
  type MlWorkerClient,
  type OrtLike,
} from "../../../src/ml/worker-protocol";

ort.env.wasm.numThreads = 1;

export const realOrt = ort as unknown as OrtLike;

/** The worker over the real runtime, with or without "WebGPU". */
export function realWorker(webgpu = false): MlWorkerClient {
  return inlineClient(
    createMlWorkerHandler(
      async () => realOrt,
      async () => webgpu,
    ),
  );
}

const PUBLIC = join(import.meta.dir, "..", "..", "..", "public");

/** A fetch over public/ (and a log of what was asked). */
export function publicFetch(
  override: (url: URL) => Uint8Array | null = () => null,
): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const f = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url.href);
    const bytes = override(url) ?? readPublic(url.pathname);
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes as Uint8Array<ArrayBuffer>);
  }) as typeof fetch;
  return { fetch: f, asked };
}

export function readPublic(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(join(PUBLIC, path)));
  } catch {
    return null;
  }
}

export const ORIGIN = "http://127.0.0.1:5173";
