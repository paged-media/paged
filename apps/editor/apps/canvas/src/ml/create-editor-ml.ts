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

// The editor's ML service, built once per editor at mount (editor ADR 290):
// the shipped registry, the OPFS model cache, the ML worker (started on the
// first model run), the local image host through the same-origin `/api/ml`
// route, and the browser's PNG codec.

import { createMlHostClient, type MlBackend } from "@paged-media/plugin-sdk";

import { reachableOrigin } from "../plugin-consent";
import { detectGpu } from "./gpu";
import {
  createMemoryModelFiles,
  createOpfsModelFiles,
  ModelStore,
} from "./model-store";
import { browserPngCodec } from "./png-codec";
import { SHIPPED_REGISTRY } from "./registry";
import { MlService } from "./service";
import { workerClient, type MlWorkerClient } from "./worker-protocol";
// Vite `?worker`: the ML worker as its own chunk, served with the page's
// COOP/COEP headers.
import MlWorker from "./ml-worker.ts?worker";

export function createEditorMlService(backend: MlBackend): MlService {
  const opfs =
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function";
  let worker: MlWorkerClient | null = null;
  const service = new MlService({
    backend,
    registry: SHIPPED_REGISTRY,
    store: new ModelStore({
      files: opfs ? createOpfsModelFiles() : createMemoryModelFiles(),
      origin: location.origin,
      admitted: reachableOrigin,
    }),
    worker: () => (worker ??= workerClient(new MlWorker())),
    host: createMlHostClient({ baseUrl: "" }),
    codec: browserPngCodec,
    detectGpu: () => detectGpu(),
  });
  const dispose = service.dispose.bind(service);
  service.dispose = () => {
    dispose();
    worker?.terminate();
    worker = null;
  };
  return service;
}
