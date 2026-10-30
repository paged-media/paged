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

// The ML worker (editor ADR 290): onnxruntime-web in a dedicated worker, so
// inference never blocks the editor's main thread. The runtime is imported
// on the first message, so an editor that never runs a model never loads
// it. The page is cross-origin isolated, so the wasm execution provider may
// use threads.

import { installDefaultPolicy } from "../boot/trusted-types";
import {
  createMlWorkerHandler,
  type OrtLike,
  type WorkerRequest,
} from "./worker-protocol";

// Trusted Types (ADR 273) hold in a worker too: onnxruntime-web's wasm
// threads are workers of this worker, started from script URLs of the
// editor's own origin (or blobs it made), which the editor's default policy
// admits. It is installed here, before the runtime loads.
installDefaultPolicy(() => false);

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  navigator: Navigator & {
    gpu?: { requestAdapter(): Promise<unknown> };
  };
};

const handle = createMlWorkerHandler(
  async () => {
    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.numThreads = Math.max(
      1,
      Math.min(4, scope.navigator.hardwareConcurrency || 1),
    );
    return ort as unknown as OrtLike;
  },
  async () =>
    !!(scope.navigator.gpu && (await scope.navigator.gpu.requestAdapter())),
);

scope.onmessage = (e) => {
  void handle(e.data).then(({ response, transfer }) =>
    scope.postMessage(response, transfer),
  );
};
